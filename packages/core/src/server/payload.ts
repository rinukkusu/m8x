import type { Prisma } from '@prisma/client';

import type { Item } from '../types.js';

/**
 * Capping what gets stored.
 *
 * A node that returns a 40MB response should not turn into a 40MB row, but the
 * first slice of it is exactly what you want to see on the failures page, so
 * truncating beats dropping. Both the NodeRun payloads and pinned data go
 * through here, so a pin can never be larger than the run it was taken from.
 */

export const MAX_PAYLOAD_BYTES = 64_000;
export const MAX_ITEMS_STORED = 50;

export interface Captured {
  value: Prisma.InputJsonValue;
  truncated: boolean;
}

export function capturePayload(items: Item[]): Captured {
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

export interface CapturedBranches {
  branches: Item[][];
  truncated: boolean;
}

/**
 * The same caps over a node's output with its branches still separated.
 *
 * The item budget is spent across the branches in order rather than per branch,
 * so a two-branch node cannot store twice as much as a one-branch node. Branches
 * that fall off the end stay present and empty: dropping them would change how
 * many outputs the node appears to have.
 */
export function capturePinnedOutput(branches: Item[][]): CapturedBranches {
  let budget = MAX_ITEMS_STORED;
  let truncated = false;

  const limited = branches.map((items) => {
    const taken = items.slice(0, Math.max(0, budget));
    budget -= taken.length;
    if (taken.length < items.length) truncated = true;
    return taken;
  });

  if (safeStringify(limited).length <= MAX_PAYLOAD_BYTES) return { branches: limited, truncated };

  // Over the byte cap. Halve the whole thing, branch by branch from the end,
  // until it fits — the same shape as the payload cap above, and for the same
  // reason: what is stored has to stay valid JSON.
  const shrunk = limited.map((items) => [...items]);
  for (let index = shrunk.length - 1; index >= 0; index--) {
    while (shrunk[index]!.length > 0 && safeStringify(shrunk).length > MAX_PAYLOAD_BYTES) {
      shrunk[index] = shrunk[index]!.slice(0, Math.floor(shrunk[index]!.length / 2));
      truncated = true;
    }
    if (safeStringify(shrunk).length <= MAX_PAYLOAD_BYTES) break;
  }

  if (safeStringify(shrunk).length > MAX_PAYLOAD_BYTES) {
    // A single item bigger than the cap on its own. There is nothing useful to
    // pin, and half an item would be worse than none.
    return { branches: branches.map(() => []), truncated: true };
  }

  return { branches: shrunk, truncated };
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '[]';
  } catch {
    // Circular structures come out of Code nodes more often than you would
    // think.
    return '[{"json":{"_unserialisable":true}}]';
  }
}
