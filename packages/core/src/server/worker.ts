import type { Graph, Item } from '../types.js';
import { runWorkflow } from '../runner/index.js';
import { loadCredentialData } from './credentials.js';
import { prisma } from './db.js';
import {
  createExecution,
  createExecutionRecorder,
  failExecution,
  finishExecution,
  markExecutionRunning,
  restoredOutputsFor,
} from './executions.js';
import {
  QUEUE_EXECUTE,
  QUEUE_SCHEDULER_TICK,
  ensureSchedulerTick,
  getBoss,
  stopQueue,
  type ExecuteJob,
} from './queue.js';
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

  log(`[worker] ready, ${concurrency} executions at a time`);
}

export async function stopWorker(): Promise<void> {
  if (!started) return;
  started = false;
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

  const graph = (execution.workflowVersion?.graph ?? null) as Graph | null;
  if (!graph) {
    await failExecution(executionId, new Error('The workflow snapshot for this run is missing.'));
    return;
  }

  const { seedItems, startNodeId } = readInput(execution.input);
  const recorder = createExecutionRecorder(executionId);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXECUTION_TIMEOUT_MS);

  try {
    await markExecutionRunning(executionId);

    const restoredOutputs =
      startNodeId && execution.retryOfId ? await restoredOutputsFor(execution.retryOfId) : undefined;

    const result = await runWorkflow({
      executionId,
      workflowId: execution.workflowId,
      mode: execution.trigger,
      graph,
      seedItems,
      startNodeId,
      restoredOutputs,
      signal: controller.signal,
      loadCredential: loadCredentialData,
      emit: (event) => recorder.handle(event),
    });

    // Flush before writing the summary, so a reader that sees a finished
    // execution always sees its node rows too.
    await recorder.flush();
    await finishExecution(executionId, result);

    log(`[worker] ${executionId} ${result.status === 'success' ? 'ok' : result.status} in ${result.durationMs}ms`);
  } catch (error) {
    await recorder.flush().catch(() => {});
    await failExecution(executionId, error);
    console.error(`[worker] ${executionId} crashed`, error);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fire every schedule that has come due.
 *
 * Claiming happens in the database with a conditional update, so running two
 * workers, or a worker alongside one embedded in the web server, does not
 * double-fire a schedule.
 */
export async function tickScheduler(log: (message: string) => void = console.info): Promise<void> {
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
      });

      log(`[scheduler] queued ${executionId} for workflow ${trigger.workflowId}`);
    } catch (error) {
      // One broken workflow must not stop the others from being scheduled.
      console.error(`[scheduler] could not queue workflow ${trigger.workflowId}`, error);
    }
  }
}

interface ExecutionInput {
  seedItems: Item[];
  startNodeId?: string;
}

function readInput(stored: unknown): ExecutionInput {
  if (Array.isArray(stored)) return { seedItems: stored as Item[] };

  if (stored && typeof stored === 'object') {
    const shaped = stored as { items?: unknown; startNodeId?: unknown };
    return {
      seedItems: Array.isArray(shaped.items) ? (shaped.items as Item[]) : [],
      startNodeId: typeof shaped.startNodeId === 'string' ? shaped.startNodeId : undefined,
    };
  }

  return { seedItems: [] };
}
