import { NodeError, type Graph, type Item } from '../types.js';
import {
  MAX_SUBWORKFLOW_DEPTH,
  runWorkflow,
  terminalOutputs,
  type RunResult,
  type SubWorkflowRequest,
  type SubWorkflowResult,
} from '../runner/index.js';
import { getBinary, pruneOrphanBinaries, putBinary } from './binary.js';
import { startDatatableTriggers } from './datatable-triggers.js';
import { loadCredentialData } from './credentials.js';
import { prisma } from './db.js';
import { readExecutionInput } from './execution-input.js';
import { startEmailPoller, stopEmailPoller } from './email-poller.js';
import {
  claimExecution,
  createExecution,
  createExecutionRecorder,
  failExecution,
  finishExecution,
  restoredOutputsFor,
} from './executions.js';
import { pinnedOutputsFor } from './pins.js';
import { pruneExecutions } from './retention.js';
import {
  QUEUE_EXECUTE,
  QUEUE_SCHEDULER_TICK,
  ensureSchedulerTick,
  getBoss,
  stopQueue,
  type ExecuteJob,
} from './queue.js';
import { startTelegramPoller, stopTelegramPoller } from './telegram-poller.js';
import { claimDueSchedules } from './triggers.js';

/**
 * The execution loop.
 *
 * It lives in core rather than in the worker app because there are two ways to
 * run it: as its own process, which is the default, or inside the web server
 * when M8X_RUN_WORKER_IN_WEB is set and you would rather deploy one container.
 * Both call `startWorker`, so the two arrangements cannot drift apart.
 */

/** A run that has been going this long is stuck rather than slow. */
const EXECUTION_TIMEOUT_MS = 60 * 60 * 1000;

export interface StartWorkerOptions {
  /** Executions in flight at once. */
  concurrency?: number;
  /** Where the log lines go. */
  log?: (message: string) => void;
}

let started = false;

export async function startWorker(options: StartWorkerOptions = {}): Promise<void> {
  // Next.js can call the instrumentation hook more than once in development,
  // and a second set of subscriptions would double every job.
  if (started) return;
  started = true;

  const concurrency = options.concurrency ?? Number(process.env.M8X_WORKER_CONCURRENCY ?? 5);
  const log = options.log ?? ((message: string) => console.info(message));

  // A datatable write turns into executions in whichever process made it, so
  // the dispatcher is registered before any node can write a row.
  startDatatableTriggers();

  const boss = await getBoss();

  await boss.work<ExecuteJob>(QUEUE_EXECUTE, { batchSize: concurrency }, async (jobs) => {
    // pg-boss hands over a batch. Running them together is the point of the
    // batch; one slow HTTP call should not hold up four other workflows.
    await Promise.all(jobs.map((job) => executeQueued(job.data.executionId, log)));
  });

  await boss.work(QUEUE_SCHEDULER_TICK, async () => {
    await tickScheduler(log);
  });

  await ensureSchedulerTick();

  // Telegram is long polling rather than a queued tick, so it runs as its own
  // loop beside the queue. Starting it here means it works unchanged in the
  // single-container arrangement, the same as everything else.
  startTelegramPoller(log);
  // IMAP is polled on its own interval for the same reason: it is not queue
  // work, and it has to keep running between executions.
  startEmailPoller(log);

  log(`[worker] ready, ${concurrency} executions at a time`);
}

export async function stopWorker(): Promise<void> {
  if (!started) return;
  started = false;
  // Before the queue, so a poll in flight cannot queue an execution into a
  // pg-boss instance that is already shutting down.
  await stopTelegramPoller();
  await stopEmailPoller();
  // Graceful, so in-flight executions finish instead of being stranded in
  // `running` for the next boot to clean up.
  await stopQueue();
}

/**
 * Run one queued execution.
 *
 * Everything this knows about how a workflow behaves comes from the runner.
 * Its own job is the boundary work: load the snapshot, wire up persistence, and
 * make sure the execution row never gets left in `running`.
 */
export async function executeQueued(
  executionId: string,
  log: (message: string) => void = console.info,
): Promise<void> {
  const execution = await prisma.execution.findUnique({
    where: { id: executionId },
    include: { workflowVersion: true },
  });

  if (!execution) {
    log(`[worker] execution ${executionId} no longer exists, dropping the job`);
    return;
  }

  if (execution.status !== 'queued') {
    // A duplicate delivery. Running it again would fire every side effect a
    // second time, which is much worse than skipping.
    log(`[worker] execution ${executionId} is already ${execution.status}, skipping`);
    return;
  }

  // The status above was read, not held. Claiming it is the check that counts,
  // because two workers can reach this line with the same job.
  if (!(await claimExecution(executionId))) {
    log(`[worker] execution ${executionId} was claimed by another worker, skipping`);
    return;
  }

  await runClaimedExecution(executionId, log);
}

interface InlineOptions {
  /** The parent's signal, so cancelling it cancels the child too. */
  signal?: AbortSignal;
  depth?: number;
  stack?: readonly string[];
}

/**
 * Run an execution whose row this process has already claimed.
 *
 * Split out of executeQueued so a sub-workflow can reuse it. Everything that
 * decides whether this process is allowed to run the row stays on the other
 * side of the split.
 */
async function runClaimedExecution(
  executionId: string,
  log: (message: string) => void,
  options: InlineOptions = {},
): Promise<{ result: RunResult; graph: Graph } | null> {
  const execution = await prisma.execution.findUnique({
    where: { id: executionId },
    include: { workflowVersion: true },
  });

  if (!execution) return null;

  const graph = (execution.workflowVersion?.graph ?? null) as Graph | null;
  if (!graph) {
    await failExecution(executionId, new Error('The workflow snapshot for this run is missing.'));
    return null;
  }

  const { seedItems, triggerNodeId, resumeFromNodeId, usePinnedData } = readExecutionInput(execution.input);
  const recorder = createExecutionRecorder(executionId);

  // A child runs under its parent's signal rather than starting a fresh hour of
  // its own: it must not outlive the run that is waiting for it.
  const controller = new AbortController();
  const inherited = options.signal;
  const abort = () => controller.abort();
  if (inherited) {
    if (inherited.aborted) abort();
    else inherited.addEventListener('abort', abort, { once: true });
  }
  const timeout = inherited ? undefined : setTimeout(abort, EXECUTION_TIMEOUT_MS);

  try {
    const restoredOutputs =
      resumeFromNodeId && execution.retryOfId
        ? await restoredOutputsFor(execution.retryOfId)
        : undefined;

    // Only for a run that asked. Nothing but the editor asks, so an activated
    // workflow cannot reach a pin however stale or convincing it is.
    const pinnedOutputs = usePinnedData
      ? await pinnedOutputsFor(execution.workflowId, graph)
      : undefined;

    const result = await runWorkflow({
      executionId,
      workflowId: execution.workflowId,
      mode: execution.trigger,
      graph,
      seedItems,
      triggerNodeId,
      resumeFromNodeId,
      restoredOutputs,
      pinnedOutputs,
      signal: controller.signal,
      loadCredential: loadCredentialData,
      readBinary: getBinary,
      // Owned by this execution from the moment a node makes it, so it is
      // cleaned up with the run even if nothing ends up referring to it.
      writeBinary: (input) => putBinary({ ...input, executionId }),
      runWorkflowById: (request) => runSubWorkflow(request, executionId, log),
      subWorkflowDepth: options.depth ?? MAX_SUBWORKFLOW_DEPTH,
      subWorkflowStack: options.stack,
      emit: (event) => recorder.handle(event),
    });

    // Flush before writing the summary, so a reader that sees a finished
    // execution always sees its node rows too.
    await recorder.flush();
    await finishExecution(executionId, result);

    log(`[worker] ${executionId} ${result.status === 'success' ? 'ok' : result.status} in ${result.durationMs}ms`);
    return { result, graph };
  } catch (error) {
    await recorder.flush().catch(() => {});
    await failExecution(executionId, error);
    console.error(`[worker] ${executionId} crashed`, error);
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (inherited) inherited.removeEventListener('abort', abort);
  }
}

/**
 * Run a workflow on behalf of an Execute Workflow node.
 *
 * The child runs here, in the parent's process, rather than going through the
 * queue. Through the queue the parent would block on a row it cannot observe
 * finishing while still holding its worker slot, and with every slot taken by a
 * parent waiting on a child that can never be picked up, the pool deadlocks.
 * Running inline also hands the child the parent's abort signal for free.
 */
async function runSubWorkflow(
  request: SubWorkflowRequest,
  parentExecutionId: string,
  log: (message: string) => void,
): Promise<SubWorkflowResult> {
  const workflow = await prisma.workflow.findUnique({
    where: { id: request.workflowId },
    select: { id: true, name: true, graph: true },
  });

  if (!workflow) {
    throw new NodeError('ConfigurationError', `There is no workflow with the id "${request.workflowId}".`);
  }

  const { executionId } = await createExecution({
    workflowId: workflow.id,
    trigger: 'subworkflow',
    input: request.items,
    // Being called by another workflow is the manual trigger's other job, so
    // that is where the child starts. Without naming it, a child holding a
    // webhook trigger as well would start at whichever of the two sits higher
    // on the canvas. Absent when the child has no manual trigger — a workflow
    // built around a webhook and also called directly — and then the first
    // trigger on the canvas is the only sensible answer, same as before.
    triggerNodeId: manualTriggerId(workflow.graph as unknown as Graph),
    parentExecutionId,
    parentNodeId: request.nodeId,
    // Waiting means running it here, so the queue must never see the row.
    enqueue: !request.wait,
  });

  if (!request.wait) {
    return { executionId, status: 'queued', items: [], workflowName: workflow.name };
  }

  if (!(await claimExecution(executionId))) {
    throw new NodeError('SubWorkflowError', 'The sub-workflow run was claimed by something else.');
  }

  const run = await runClaimedExecution(executionId, log, {
    signal: request.signal,
    depth: request.depth - 1,
    stack: request.stack,
  });

  if (!run) {
    return { executionId, status: 'failed', items: [], workflowName: workflow.name };
  }

  return {
    executionId,
    status: run.result.status,
    items: terminalOutputs(run.graph, run.result.outputs),
    workflowName: workflow.name,
    failure: run.result.failure,
  };
}

/**
 * Fire every schedule that has come due.
 *
 * Claiming happens in the database with a conditional update, so running two
 * workers, or a worker alongside one embedded in the web server, does not
 * double-fire a schedule.
 */
export async function tickScheduler(log: (message: string) => void = console.info): Promise<void> {
  // Stored files whose run never got queued have nothing to delete them, and
  // the minute tick is the only thing in the system that runs regardless of
  // whether any workflow does. The query is indexed and matches nothing on a
  // normal tick.
  await pruneOrphanBinaries().catch((error: unknown) => console.error('[worker] binary prune failed', error));

  // Retention rides the same tick, for the same reason and in bounded batches,
  // so history that is past the policy goes whether or not anything is running.
  // Nothing is logged on a quiet tick: the query is indexed and matches nothing
  // once an instance has caught up.
  await pruneExecutions()
    .then((result) => {
      if (result.deleted > 0) {
        log(`[retention] deleted ${result.deleted} executions${result.moreToDo ? ', more next tick' : ''}`);
      }
    })
    .catch((error: unknown) => console.error('[worker] retention prune failed', error));

  const due = await claimDueSchedules();
  if (due.length === 0) return;

  for (const trigger of due) {
    try {
      const workflow = await prisma.workflow.findUnique({
        where: { id: trigger.workflowId },
        select: { active: true },
      });

      // A workflow deactivated between the claim and now should not run.
      if (!workflow?.active) continue;

      const { executionId } = await createExecution({
        workflowId: trigger.workflowId,
        trigger: 'schedule',
        input: [{ json: { triggeredAt: new Date().toISOString() } }],
        // Naming it matters on a workflow holding more than one trigger: without
        // it the run would start at whichever trigger sits highest on the canvas
        // rather than the schedule that actually came due.
        triggerNodeId: trigger.nodeId,
      });

      log(`[scheduler] queued ${executionId} for workflow ${trigger.workflowId}`);
    } catch (error) {
      // One broken workflow must not stop the others from being scheduled.
      console.error(`[scheduler] could not queue workflow ${trigger.workflowId}`, error);
    }
  }
}

/**
 * The manual trigger of a workflow being run by an Execute Workflow node.
 *
 * Undefined when there is none, or it is switched off, which leaves the run
 * without a named trigger and falls back to the first one on the canvas.
 *
 * Exported for the test: it is the whole of the rule about where a sub-workflow
 * run enters, and the rest of `runSubWorkflow` needs a database to reach.
 */
export function manualTriggerId(graph: Graph): string | undefined {
  return graph.nodes.find((node) => node.type === 'trigger.manual' && !node.disabled)?.id;
}
