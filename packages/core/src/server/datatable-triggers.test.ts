import assert from 'node:assert/strict';
import test from 'node:test';

import type { DatatableChangeSet } from './datatable-changes.js';
import { itemFor, rowMatches, triggerWants } from './datatable-triggers.js';

/** Which changes a datatable trigger wants, before any of them reach a queue. */

const change = (over: Partial<DatatableChangeSet> = {}): DatatableChangeSet => ({
  datatableId: 'dt_1',
  event: 'update',
  rows: [{ rowId: 'r1', row: { status: 'shipped' }, previous: { status: 'open' } }],
  source: null,
  ...over,
});

test('a trigger ignores tables that are not its own', () => {
  assert.equal(triggerWants({ datatableId: 'dt_2' }, change()), false);
});

test('a trigger with no events configured listens for all of them', () => {
  assert.equal(triggerWants({ datatableId: 'dt_1', events: [] }, change()), true);
});

test('an event the trigger did not ask for is skipped', () => {
  const config = { datatableId: 'dt_1', events: ['insert'] };
  assert.equal(triggerWants(config, change({ event: 'update' })), false);
  assert.equal(triggerWants(config, change({ event: 'insert' })), true);
});

test('watched columns filter updates by what actually changed', () => {
  const config = { datatableId: 'dt_1', watchColumns: ['status'] };
  const row = { rowId: 'r1', row: { status: 'shipped' }, previous: { status: 'open' } };
  const untouched = { rowId: 'r2', row: { status: 'open', note: 'b' }, previous: { status: 'open', note: 'a' } };

  assert.equal(rowMatches(config, change(), row), true);
  assert.equal(rowMatches(config, change(), untouched), false);
});

test('watched columns do not apply to inserts, which change everything', () => {
  const config = { datatableId: 'dt_1', watchColumns: ['status'] };
  const inserted = { rowId: 'r1', row: { status: 'open' } };
  assert.equal(rowMatches(config, change({ event: 'insert' }), inserted), true);
});

test('the event rides beside the row, so one workflow can branch on it', () => {
  const item = itemFor(change({ event: 'delete' }), { rowId: 'r1', previous: { status: 'open' } });
  assert.equal(item.json.event, 'delete');
  assert.equal(item.json.rowId, 'r1');
  assert.deepEqual(item.json.previous, { status: 'open' });
  assert.equal('row' in item.json, false);
});
