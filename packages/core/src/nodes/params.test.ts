import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveTimeout } from './params.js';

/** Coercion for the parameters the runtime cannot take at face value. */

test('a cleared timeout field falls back rather than meaning zero', () => {
  // Number('') is 0, and both setTimeout and AbortSignal.timeout treat 0 as
  // "on the next tick", which would abort every request before it left.
  assert.equal(resolveTimeout('', 30_000, 600_000), 30_000);
  assert.equal(resolveTimeout(undefined, 30_000, 600_000), 30_000);
  assert.equal(resolveTimeout('not a number', 30_000, 600_000), 30_000);
  assert.equal(resolveTimeout(0, 30_000, 600_000), 30_000);
  assert.equal(resolveTimeout(-5, 30_000, 600_000), 30_000);
});

test('a timeout is capped and rounded', () => {
  assert.equal(resolveTimeout('5000', 30_000, 600_000), 5000);
  assert.equal(resolveTimeout(1500.6, 30_000, 600_000), 1501);
  assert.equal(resolveTimeout(9_000_000, 30_000, 600_000), 600_000);
});
