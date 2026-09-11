import type { Graph, Item } from '@m8x/core';
import {
  createExecutionRecorder,
  failExecution,
  finishExecution,
  loadCredentialData,
  markExecutionRunning,
  prisma,
  restoredOutputsFor,
  runWorkflow,
} from '@m8x/core/server';

/** A run that has been going this long is stuck rather than slow. */
const EXECUTION_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Run one queued execution.
 *
 * Everything this function knows about how a workflow behaves comes from the
 * runner in core. Its own job is the boundary work: load the snapshot, wire up
 * persistence, and make sure the execution row never gets left in `running`.
 */
export async function executeQueued(executionId: string): Promise<void> {
  const execution = await prisma.execution.findUnique({
    where: { id: executionId },
    include: { workflowVersion: true },
  });

  if (!execution) {
    console.warn(`[worker] execution ${executionId} no longer exists, dropping the job`);
    return;
  }

  if (execution.status !== 'queued') {
    // A duplicate delivery. Running it again would fire every side effect a
    // second time, which is much worse than skipping.
    console.warn(`[worker] execution ${executionId} is already ${execution.status}, skipping`);
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

    const restoredOutputs = startNodeId && execution.retryOfId
      ? await restoredOutputsFor(execution.retryOfId)
      : undefined;

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

    const label = result.status === 'success' ? 'ok' : result.status;
    console.info(`[worker] ${executionId} ${label} in ${result.durationMs}ms`);
  } catch (error) {
    await recorder.flush().catch(() => {});
    await failExecution(executionId, error);
    console.error(`[worker] ${executionId} crashed`, error);
  } finally {
    clearTimeout(timeout);
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
