import assert from 'node:assert/strict';
import test from 'node:test';

import { paramUsesExpressions } from '../index.js';
import { datatableFilterParams } from '../descriptors/datatable.js';
import { asColumnList, filterFor, rowFromItem } from './datatable.js';
import type { Item, NodeExecuteContext } from '../../types.js';

/** The parts of the datatable nodes that do not need a database to be wrong. */

/** Just enough context: the items, and parameters resolved per item. */
function context(items: Item[], params: Record<string, unknown>): NodeExecuteContext {
  return {
    items,
    getParam: (name: string) => params[name],
  } as unknown as NodeExecuteContext;
}

test('a filter value is expression-resolved, or it could never match the item', () => {
  const filter = datatableFilterParams.find((param) => param.name === 'filter');
  assert.ok(filter);
  assert.equal(paramUsesExpressions(filter), true);
});

test('the whole item becomes the row, minus the id this node family added', () => {
  const ctx = context([{ json: { email: 'a@b.c', $rowId: 'row_1' } }], { mode: 'item' });
  assert.deepEqual(rowFromItem(ctx, 0), { email: 'a@b.c' });
});

test('in fields mode only the mapped fields become the row', () => {
  const ctx = context([{ json: { email: 'a@b.c', secret: 'x' } }], {
    mode: 'fields',
    fields: [
      { key: ' email ', value: 'a@b.c' },
      { key: '', value: 'dropped' },
      'nonsense',
    ],
  });
  assert.deepEqual(rowFromItem(ctx, 0), { email: 'a@b.c' });
});

test('a half-written filter row is dropped, and the combinator is read beside it', () => {
  const ctx = context([{ json: {} }], {
    filter: [{ field: 'status', operator: 'equals', value: 'open' }, { field: '' }],
    filterCombinator: 'or',
  });
  assert.deepEqual(filterFor(ctx, 0), {
    combinator: 'or',
    conditions: [{ field: 'status', operator: 'equals', value: 'open' }],
  });
});

test('a multi-select written as a single string still reads as one column', () => {
  assert.deepEqual(asColumnList('email'), ['email']);
  assert.deepEqual(asColumnList(['email', '', 7]), ['email']);
  assert.deepEqual(asColumnList(undefined), []);
});
