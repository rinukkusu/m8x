import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateExpression, resolveValue } from './expressions.js';
import { scope } from './test-support.js';

/** The `{{ }}` language: what it evaluates, and what it refuses to. */

test('expressions read nested values and keep their type', () => {
  assert.equal(resolveValue('{{ $json.order.total }}', scope({ order: { total: 42 } })), 42);
  assert.equal(resolveValue('Total: {{ $json.order.total }}', scope({ order: { total: 42 } })), 'Total: 42');
});

test('expressions support arithmetic, comparison and ternaries', () => {
  const s = scope({ a: 10, b: 3, name: 'ada' });
  assert.equal(evaluateExpression('$json.a * $json.b + 1', s), 31);
  assert.equal(evaluateExpression('$json.a > $json.b', s), true);
  assert.equal(evaluateExpression('$json.a > 100 ? "big" : "small"', s), 'small');
  assert.equal(evaluateExpression('$json.name.toUpperCase()', s), 'ADA');
});

test('a missing value yields undefined rather than throwing', () => {
  assert.equal(evaluateExpression('$json.nope.deeper', scope({})), undefined);
});

test('nullish coalescing short-circuits', () => {
  assert.equal(evaluateExpression('$json.missing ?? "fallback"', scope({})), 'fallback');
});

test('expressions cannot reach the prototype chain', () => {
  assert.throws(() => evaluateExpression('$json.constructor', scope({})), /not allowed/);
  assert.throws(() => evaluateExpression('$json["__proto__"]', scope({})), /not allowed/);
});

test('prototype members are not variables', () => {
  // `name in scope` would find these on Object.prototype and hand back the
  // real constructor.
  assert.throws(() => evaluateExpression('constructor', scope({})), /Unknown variable/);
  assert.throws(() => evaluateExpression('hasOwnProperty', scope({})), /Unknown variable/);
});

test('a number with two dots is not silently NaN', () => {
  assert.throws(() => evaluateExpression('1.2.3', scope({})), /Expected a property name/);
});

test('expressions cannot call methods that are not whitelisted', () => {
  assert.throws(() => evaluateExpression('$json.name.padEndX()', scope({ name: 'x' })), /not available/);
});

test('unknown variables are named in the error', () => {
  assert.throws(() => evaluateExpression('$jsonn.foo', scope({})), /Unknown variable \$jsonn/);
});

test('expressions resolve inside nested objects and arrays', () => {
  const value = { list: ['{{ $json.a }}', 'literal'], nested: { x: '{{ $json.a }}' } };
  assert.deepEqual(resolveValue(value, scope({ a: 7 })), { list: [7, 'literal'], nested: { x: 7 } });
});

// ---------------------------------------------------------------------------
// Limits
//
// Both of these protect the worker process rather than the workflow: an
// expression that overflows the stack or exhausts memory takes down every
// execution sharing the process, not just the node that has the typo.
// ---------------------------------------------------------------------------

test('an expression that would build an enormous string is refused', () => {
  assert.throws(
    () => evaluateExpression('"a".repeat(1000000000)', scope({})),
    /would build a string of 1,000,000,000 characters/,
  );
  assert.throws(() => evaluateExpression('"a".padStart(5000000)', scope({})), /past the 1,000,000/);
  assert.throws(() => evaluateExpression('"a".padEnd(5000000)', scope({})), /past the 1,000,000/);
});

test('the string limit leaves ordinary padding and repetition alone', () => {
  assert.equal(evaluateExpression('"ab".repeat(3)', scope({})), 'ababab');
  assert.equal(evaluateExpression('"7".padStart(3, "0")', scope({})), '007');
  assert.equal(evaluateExpression('"x".repeat($json.n)', scope({ n: 4 })), 'xxxx');
});

test('a deeply nested expression is refused rather than overflowing the stack', () => {
  const nested = `${'('.repeat(500)}1${')'.repeat(500)}`;
  assert.throws(() => evaluateExpression(nested, scope({})), /nests too deeply/);

  // Unary operators recurse too, and do not go through the same path.
  assert.throws(() => evaluateExpression(`${'!'.repeat(500)}true`, scope({})), /nests too deeply/);
});

test('nesting a workflow would really use is still fine', () => {
  assert.equal(evaluateExpression('((1 + 2) * (3 - 1)) / ((4 - 2) + 1)', scope({})), 2);
  assert.equal(
    evaluateExpression('$json.a.b.c.d + $json.a.b.c.e', scope({ a: { b: { c: { d: 1, e: 2 } } } })),
    3,
  );
});

test('a long flat expression is not nesting, and is not capped by the depth limit', () => {
  // 400 terms: the parser loops rather than recursing, which is the whole
  // reason the depth limit can be as low as it is.
  const sum = Array.from({ length: 400 }, () => '1').join(' + ');
  assert.equal(evaluateExpression(sum, scope({})), 400);
});

test('a flat expression long enough to overflow the evaluator is refused', () => {
  // Flat in the parser and 10,000 deep in the tree it builds, which is where
  // this used to come apart: the depth limit never saw it, and `evaluate`
  // recursed once per term until the stack ran out. The length limit is what
  // catches this shape, and it fails as an expression rather than as a
  // RangeError from somewhere inside the runner.
  const sum = Array.from({ length: 10_000 }, () => '1').join(' + ');
  assert.throws(() => evaluateExpression(sum, scope({})), /tokens long, past the 2,000/);

  // A member chain is the same story with a different token.
  const chain = `$json${'.a'.repeat(10_000)}`;
  assert.throws(() => evaluateExpression(chain, scope({})), /tokens long, past the 2,000/);
});

test('the length limit leaves an expression anyone would write alone', () => {
  const chain = `$json${'.a'.repeat(50)}`;
  assert.doesNotThrow(() => evaluateExpression(chain, scope({})));

  const sum = Array.from({ length: 400 }, () => '1').join(' + ');
  assert.doesNotThrow(() => evaluateExpression(sum, scope({})));
});
