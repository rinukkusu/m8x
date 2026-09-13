import assert from 'node:assert/strict';
import test from 'node:test';

import { compare } from './conditions.js';

/** The comparisons behind If, Filter and Switch. */

test('equality is loose, because webhook payloads are all strings', () => {
  assert.equal(compare('5', 'equals', 5), true);
  assert.equal(compare(5, 'notEquals', '6'), true);
});

test('comparing non-numbers numerically fails loudly', () => {
  assert.throws(() => compare('abc', 'gt', 3), /Cannot compare/);
});
