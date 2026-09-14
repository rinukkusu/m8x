import assert from 'node:assert/strict';
import test from 'node:test';

import { DATATABLE_GET_MAX_LIMIT, clampLimit, parseFilter } from './filter.js';

/** Reading a filter back out of what the inspector stored. */

test('a half-written row is dropped rather than matching everything', () => {
  const filter = parseFilter([
    { field: 'status', operator: 'equals', value: 'open' },
    { field: '  ', operator: 'equals', value: 'x' },
  ]);
  assert.equal(filter.conditions.length, 1);
});

test('an unknown operator falls back to equality', () => {
  const filter = parseFilter([{ field: 'status', operator: 'sounds-like', value: 'open' }]);
  assert.equal(filter.conditions[0]?.operator, 'equals');
});

test('a read limit is clamped rather than refused, and says so', () => {
  assert.deepEqual(clampLimit(5000), { limit: DATATABLE_GET_MAX_LIMIT, clamped: true });
  assert.deepEqual(clampLimit(10), { limit: 10, clamped: false });
  assert.deepEqual(clampLimit(undefined), { limit: 50, clamped: false });
});
