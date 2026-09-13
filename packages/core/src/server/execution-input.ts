import type { Item } from '../types.js';

/**
 * The shape of `Execution.input`, written by whoever queues a run and read back
 * by the worker that picks it up.
 *
 * Both halves live here because they have to agree, and they used to sit in two
 * files: a key added on the writing side and missed on the reading side is a
 * run that silently ignores it. Nothing else knows the payload's shape.
 */

export interface ExecutionInput {
  /** Items handed to the trigger node. */
  seedItems: Item[];
  /**
   * Which trigger node fired, for a workflow that holds more than one. Absent
   * for a manual run, which means the first trigger on the canvas.
   */
  triggerNodeId?: string;
  /** Node a retry picks up from, skipping everything before it. */
  resumeFromNodeId?: string;
}

/**
 * Stored as a bare array when there is nothing but items to say, which is the
 * overwhelming majority of runs and keeps the column readable.
 */
export function storedExecutionInput(input: ExecutionInput): unknown {
  if (input.triggerNodeId === undefined && input.resumeFromNodeId === undefined) {
    return input.seedItems;
  }

  return {
    items: input.seedItems,
    ...(input.triggerNodeId === undefined ? {} : { triggerNodeId: input.triggerNodeId }),
    ...(input.resumeFromNodeId === undefined ? {} : { resumeFromNodeId: input.resumeFromNodeId }),
  };
}

/**
 * Read a stored payload back, in any shape it has ever been written in.
 *
 * `startNodeId` is the older spelling, from when one field carried both "which
 * trigger fired" and "where to resume". Rows written before the split are still
 * sitting in the queue during an upgrade, and there it meant both at once, so
 * that is what it is read as. Anything unrecognisable becomes an empty run
 * rather than a crash: a malformed payload should fail as a workflow with
 * nothing to work on, not as a worker that cannot start.
 */
export function readExecutionInput(stored: unknown): ExecutionInput {
  if (Array.isArray(stored)) return { seedItems: stored as Item[] };

  if (stored && typeof stored === 'object') {
    const shaped = stored as {
      items?: unknown;
      triggerNodeId?: unknown;
      resumeFromNodeId?: unknown;
      startNodeId?: unknown;
    };
    const legacy = asNodeId(shaped.startNodeId);

    return {
      seedItems: Array.isArray(shaped.items) ? (shaped.items as Item[]) : [],
      triggerNodeId: asNodeId(shaped.triggerNodeId) ?? legacy,
      resumeFromNodeId: asNodeId(shaped.resumeFromNodeId) ?? legacy,
    };
  }

  return { seedItems: [] };
}

function asNodeId(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
