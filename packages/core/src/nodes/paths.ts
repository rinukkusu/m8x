import { NodeError } from '../types.js';

/**
 * Dotted field paths, as typed into node parameters.
 *
 * `customer.name` reading and writing a nested field is what people expect, but
 * the same syntax reaches `__proto__.isAdmin` if nothing stops it. Writing
 * there does not touch the item at all: it lands on `Object.prototype` and
 * changes every object in the worker process, including the ones belonging to
 * the other executions running alongside it.
 */

const UNSAFE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function isUnsafe(segment: string): boolean {
  return UNSAFE_SEGMENTS.has(segment);
}

/** Read a dotted path, or undefined when any step of it is missing. */
export function readPath(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source;

  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    // Reading these yields internals rather than the author's data, so they are
    // treated as absent rather than refused.
    if (isUnsafe(segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

/**
 * Write a dotted path, creating the objects along the way.
 *
 * Refuses rather than silently dropping the segment: a Set node that says it
 * wrote a field it did not write is worse than one that fails.
 */
export function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');

  const unsafe = segments.find(isUnsafe);
  if (unsafe) {
    throw new NodeError('ConfigurationError', `"${path}" is not a field name that can be written to.`, {
      path,
      segment: unsafe,
    });
  }

  let current = target;

  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    const next = current[segment];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }

  current[segments[segments.length - 1]!] = value;
}
