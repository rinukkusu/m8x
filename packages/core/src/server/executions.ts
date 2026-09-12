import type { Prisma } from '@prisma/client';

import { errorFingerprint } from '../fingerprint.js';
import type { Graph, Item } from '../types.js';
import type { RunEvent, RunResult } from '../runner/index.js';
import { prisma } from './db.js';
import { enqueueExecution } from './queue.js';

/**
 * Creating, recording and retrying executions.
 *
 * The web app and the worker both need this, so it lives in core rather than
 * in either one. The web app creates the row and enqueues; the worker consumes
 * the runner's events and writes them back.
 */

// Payload caps. A node that returns a 40MB response should not turn into a
// 40MB row, but the first slice of it is exactly what you want to see on the
// failures page, so truncating beats dropping.
const MAX_PAYLOAD_BYTES = 64_000;
const MAX_ITEMS_STORED = 50;

export interface CreateExecutionInput {
  workflowId: string;
  trigger: 'manual' | 'webhook' | 'schedule' | 'retry';
  /** Items handed to the trigger node. */
  input?: Item[];
  /** Node the run should start from. Only set by retries. */
  startNodeId?: string;
  retryOfId?: string;
}

export interface CreatedExecution {
  executionId: string;
  workflowVersionId: string;
}

/**
 * Snapshot the workflow, create the execution row, and queue it.
 *
 * The version snapshot is the important part. Without it, editing a workflow
 * would silently rewrite the history of every run that came before, and the
 * detail view would show a graph that never actually ran.
 */
export async function createExecution(input: CreateExecutionInput): Promise<CreatedExecution> {
  const workflow = await prisma.workflow.findUniqueOrThrow({ where: { id: input.workflowId } });
  const versionId = await ensureCurrentVersion(workflow.id, workflow.graph as unknown as Graph, workflow.currentVersionId);

  const execution = await prisma.execution.create({
    data: {
      workflowId: workflow.id,
      workflowVersionId: versionId,
      status: 'queued',
      trigger: input.trigger,
      input: (input.input ?? []) as unknown as Prisma.InputJsonValue,
      retryOfId: input.retryOfId,
    },
    select: { id: true },
  });

  // The start node rides along in the input payload rather than getting its own
  // column, since only retries ever set it.
  if (input.startNodeId) {
    await prisma.execution.update({
      where: { id: execution.id },
      data: {
        input: {
          items: (input.input ?? []) as unknown as Prisma.InputJsonValue,
          startNodeId: input.startNodeId,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  await enqueueExecution({ executionId: execution.id });

  return { executionId: execution.id, workflowVersionId: versionId };
}

/**
 * Return the id of a version matching the current graph, creating one if the
 * workflow has been edited since the last run. Runs that change nothing reuse
 * the same version instead of piling up identical snapshots.
 */
export async function ensureCurrentVersion(
  workflowId: string,
  graph: Graph,
  currentVersionId: string | null,
): Promise<string> {
  if (currentVersionId) {
    const existing = await prisma.workflowVersion.findUnique({ where: { id: currentVersionId } });
    if (existing && JSON.stringify(existing.graph) === JSON.stringify(graph)) return existing.id;
  }

  const latest = await prisma.workflowVersion.findFirst({
    where: { workflowId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });

  const version = await prisma.workflowVersion.create({
    data: {
      workflowId,
      version: (latest?.version ?? 0) + 1,
      graph: graph as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  await prisma.workflow.update({
    where: { id: workflowId },
    data: { currentVersionId: version.id },
  });

  return version.id;
}

// ---------------------------------------------------------------------------
// Recording a run
// ---------------------------------------------------------------------------

/**
 * Turn runner events into database rows.
 *
 * Writes are serialised through a promise chain rather than fired in parallel,
 * so NodeRun rows land in the order the runner produced them even when two
 * nodes finish in the same tick.
 */
export function createExecutionRecorder(executionId: string) {
  let chain: Promise<unknown> = Promise.resolve();
  const logsByNode = new Map<string, Array<{ level: string; message: string; at: string }>>();
  const nodeRunIds = new Map<string, string>();

  function queue<T>(work: () => Promise<T>): void {
    chain = chain.then(work).catch((error) => {
      // Losing a NodeRun row is bad but not worth killing the run over: the
      // workflow's actual side effects are already in flight.
      console.error(`[execution ${executionId}] failed to record an event`, error);
    });
  }

  return {
    handle(event: RunEvent): void {
      if (event.type === 'log') {
        const bucket = logsByNode.get(event.nodeId) ?? [];
        if (bucket.length < 200) {
          bucket.push({ level: event.level, message: event.message, at: event.at.toISOString() });
        }
        logsByNode.set(event.nodeId, bucket);
        return;
      }

      if (event.type === 'nodeStart') {
        queue(async () => {
          const captured = capture(event.input);
          const row = await prisma.nodeRun.create({
            data: {
              executionId,
              nodeId: event.nodeId,
              nodeName: event.nodeName,
              nodeType: event.nodeType,
              status: 'running',
              attempt: event.attempt,
              sequence: event.sequence,
              startedAt: event.startedAt,
              input: captured.value,
              inputTruncated: captured.truncated,
            },
            select: { id: true },
          });
          nodeRunIds.set(`${event.nodeId}:${event.attempt}`, row.id);
        });
        return;
      }

      queue(async () => {
        const key = `${event.nodeId}:${event.attempt}`;
        const existingId = nodeRunIds.get(key);
        const output = event.output ? capture(event.output) : { value: undefined, truncated: false };
        const logs = logsByNode.get(event.nodeId);

        const data = {
          status: event.status,
          finishedAt: event.finishedAt,
          durationMs: event.durationMs,
          output: output.value,
          outputTruncated: output.truncated,
          error: event.error
            ? ({ ...event.error, willRetry: event.willRetry ?? false, logs } as unknown as Prisma.InputJsonValue)
            : logs
              ? ({ logs } as unknown as Prisma.InputJsonValue)
              : undefined,
        };

        if (existingId) {
          await prisma.nodeRun.update({ where: { id: existingId }, data });
          return;
        }

        // Skipped nodes never emit a start event, so there is no row to update.
        await prisma.nodeRun.create({
          data: {
            executionId,
            nodeId: event.nodeId,
            nodeName: event.nodeName,
            nodeType: event.nodeType,
            attempt: event.attempt,
            sequence: event.sequence,
            startedAt: event.finishedAt,
            ...data,
          },
        });
      });
    },

    /** Resolves once every queued write has landed. */
    async flush(): Promise<void> {
      await chain;
    },
  };
}

/**
 * Take ownership of a queued execution, returning false when someone else
 * already has it.
 *
 * Conditional on the row still being `queued`, so two workers handed the same
 * job by a duplicate delivery cannot both run it and fire every side effect
 * twice. Reading the status and then writing it would leave exactly that gap.
 */
export async function claimExecution(executionId: string): Promise<boolean> {
  const { count } = await prisma.execution.updateMany({
    where: { id: executionId, status: 'queued' },
    data: { status: 'running', startedAt: new Date() },
  });

  return count === 1;
}

export async function finishExecution(executionId: string, result: RunResult): Promise<void> {
  const finishedAt = new Date();

  await prisma.execution.update({
    where: { id: executionId },
    data: {
      status: result.status === 'cancelled' ? 'cancelled' : result.status,
      finishedAt,
      durationMs: result.durationMs,
      errorNodeId: result.failure?.nodeId ?? null,
      errorNodeName: result.failure?.nodeName ?? null,
      errorType: result.failure?.errorType ?? null,
      errorMessage: result.failure?.message ?? null,
      errorFingerprint: result.failure?.fingerprint ?? null,
    },
  });
}

/** Record a failure that happened outside the runner, e.g. a crashed worker. */
export async function failExecution(executionId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const errorType = error instanceof Error ? error.name : 'WorkerError';

  await prisma.execution.update({
    where: { id: executionId },
    data: {
      status: 'failed',
      finishedAt: new Date(),
      errorType,
      errorMessage: message,
      errorFingerprint: errorFingerprint({ nodeType: 'worker', errorType, message }),
    },
  });
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** Start from the node that failed instead of from the beginning. */
  fromFailedNode?: boolean;
}

/**
 * Re-run an execution.
 *
 * Retrying from the failed node is the common case and the reason NodeRun keeps
 * its inputs: everything upstream already ran, and repeating it would fire its
 * side effects twice. Falling back to a full re-run is correct when the
 * upstream payloads were truncated, because a partial input would produce a
 * subtly wrong result rather than an obvious failure.
 */
export async function retryExecution(executionId: string, options: RetryOptions = {}): Promise<string> {
  const original = await prisma.execution.findUniqueOrThrow({
    where: { id: executionId },
    include: { nodeRuns: { orderBy: { sequence: 'asc' } } },
  });

  const storedInput = original.input as { items?: Item[] } | Item[] | null;
  const seedItems = Array.isArray(storedInput) ? storedInput : (storedInput?.items ?? []);

  let startNodeId: string | undefined;

  if (options.fromFailedNode && original.errorNodeId) {
    const failedRun = original.nodeRuns.find((run) => run.nodeId === original.errorNodeId);
    const upstreamTruncated = original.nodeRuns.some(
      (run) => run.sequence < (failedRun?.sequence ?? 0) && run.outputTruncated,
    );
    if (failedRun && !upstreamTruncated) startNodeId = original.errorNodeId;
  }

  const created = await createExecution({
    workflowId: original.workflowId,
    trigger: 'retry',
    input: seedItems,
    startNodeId,
    retryOfId: original.id,
  });

  return created.executionId;
}

/** Outputs of every node that succeeded before the failure, for a partial retry. */
export async function restoredOutputsFor(executionId: string): Promise<Record<string, Item[][]>> {
  const runs = await prisma.nodeRun.findMany({
    where: { executionId, status: 'success' },
    orderBy: { sequence: 'asc' },
    select: { nodeId: true, output: true },
  });

  const outputs: Record<string, Item[][]> = {};
  for (const run of runs) {
    const items = (run.output ?? []) as unknown as Item[];
    // NodeRun flattens the branches for display. A retry can only restore the
    // first branch, which is why a retry from downstream of an If starts from
    // the If rather than from the node after it.
    outputs[run.nodeId] = [Array.isArray(items) ? items : []];
  }

  return outputs;
}

// ---------------------------------------------------------------------------
// Payload capture
// ---------------------------------------------------------------------------

interface Captured {
  value: Prisma.InputJsonValue;
  truncated: boolean;
}

function capture(items: Item[]): Captured {
  const limited = items.slice(0, MAX_ITEMS_STORED);
  let truncated = limited.length < items.length;

  let serialised = safeStringify(limited);

  if (serialised.length > MAX_PAYLOAD_BYTES) {
    truncated = true;
    // Halve until it fits rather than cutting the string, so what lands in the
    // column is still valid JSON that the detail view can render.
    let count = limited.length;
    let candidate = limited;
    while (count > 1 && serialised.length > MAX_PAYLOAD_BYTES) {
      count = Math.floor(count / 2);
      candidate = limited.slice(0, count);
      serialised = safeStringify(candidate);
    }
    if (serialised.length > MAX_PAYLOAD_BYTES) {
      return {
        value: [{ json: { _truncated: true, preview: serialised.slice(0, 2000) } }] as unknown as Prisma.InputJsonValue,
        truncated: true,
      };
    }
    return { value: candidate as unknown as Prisma.InputJsonValue, truncated };
  }

  return { value: limited as unknown as Prisma.InputJsonValue, truncated };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '[]';
  } catch {
    // Circular structures come out of Code nodes more often than you would
    // think.
    return '[{"json":{"_unserialisable":true}}]';
  }
}
