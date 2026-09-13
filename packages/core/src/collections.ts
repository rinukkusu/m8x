/**
 * Appending one list of items onto another.
 *
 * `target.push(...source)` is the obvious way to write this and the wrong one
 * here: the spread passes every item as a separate argument, and the engine's
 * argument limit is somewhere around a hundred thousand. A workflow moving that
 * many items is unusual but entirely legitimate — a full table export, a large
 * CSV — and it would die with a stack overflow from deep inside the runner
 * rather than anywhere near the node that produced the items.
 */
export function appendAll<T>(target: T[], source: readonly T[]): T[] {
  for (const entry of source) target.push(entry);
  return target;
}
