import assert from 'node:assert/strict';
import test from 'node:test';

import { DATATABLE_ROW_MAX_BYTES, coerceRow, parseColumns } from './columns.js';

/** What declaring a column is worth when a row is written. */

const columns = parseColumns([
  { key: 'email', name: 'Email', type: 'string', required: true },
  { key: 'total', name: 'Total', type: 'number' },
  { key: 'active', name: 'Active', type: 'boolean' },
  { key: 'seenAt', name: 'Seen at', type: 'datetime' },
]);

test('declared columns are coerced, so a filter compares like with like', () => {
  const row = coerceRow(columns, { email: 'a@b.c', total: '42', active: 'yes' });
  assert.equal(row.total, 42);
  assert.equal(row.active, true);
});

test('undeclared keys are kept, so a payload growing a field breaks nothing', () => {
  const row = coerceRow(columns, { email: 'a@b.c', shippingNote: 'leave at door' });
  assert.equal(row.shippingNote, 'leave at door');
});

test('a required column that is empty fails the write', () => {
  assert.throws(() => coerceRow(columns, { email: '' }), /is required/);
});

test('a value that cannot be coerced fails, rather than storing text in a number', () => {
  assert.throws(() => coerceRow(columns, { email: 'a@b.c', total: 'lots' }), /expects a number/);
});

test('dates are stored as ISO-8601, so sorting the text sorts the instants', () => {
  const row = coerceRow(columns, { email: 'a@b.c', seenAt: '2026-09-14T08:30:00+02:00' });
  assert.equal(row.seenAt, '2026-09-14T06:30:00.000Z');
});

test('an absent optional column stays absent rather than becoming null', () => {
  const row = coerceRow(columns, { email: 'a@b.c' });
  assert.equal('total' in row, false);
});

test('a row over the size cap is refused', () => {
  const big = { email: 'a@b.c', blob: 'x'.repeat(DATATABLE_ROW_MAX_BYTES) };
  assert.throws(() => coerceRow(columns, big), /over the 64 kB limit/);
});

test('metadata from a newer m8x is dropped rather than breaking the page', () => {
  const parsed = parseColumns([
    { key: 'ok', name: 'Ok', type: 'string' },
    { key: '2bad', name: 'Bad key', type: 'string' },
    { key: 'ok', name: 'Duplicate', type: 'string' },
    { key: 'odd', name: 'Odd type', type: 'geography' },
    'nonsense',
  ]);
  assert.deepEqual(
    parsed.map((column) => `${column.key}:${column.type}`),
    ['ok:string', 'odd:string'],
  );
});
