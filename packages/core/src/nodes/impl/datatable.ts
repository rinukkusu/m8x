import { parseFilter, clampLimit, type DatatableFilter, type DatatableSort } from '../../datatables/filter.js';
import {
  deleteRows,
  getRows,
  insertRows,
  updateRows,
  upsertRows,
  type DatatableRow,
} from '../../server/datatables.js';
import { NodeError, type Item, type NodeExecute, type NodeExecuteContext } from '../../types.js';

/**
 * The five datatable actions.
 *
 * These reach the storage module directly, the way the email node reaches
 * nodemailer: the runner's context callbacks exist for things that need runner
 * state — the sub-workflow stack, the execution's binaries — and a row write
 * needs none of it beyond who is asking.
 */

/** Who is writing, so a trigger on the table can recognise its own workflow. */
function sourceOf(ctx: NodeExecuteContext) {
  return { workflowId: ctx.workflowId, executionId: ctx.executionId };
}

function requireTableId(ctx: NodeExecuteContext, itemIndex = 0): string {
  const id = ctx.getParam<string>('datatableId', itemIndex);
  if (!id) throw new NodeError('ConfigurationError', 'No datatable is selected.');
  return id;
}

/** The key/value rows a `keyValue` parameter holds, as one object. */
function fieldsOf(ctx: NodeExecuteContext, name: string, itemIndex: number): Record<string, unknown> {
  const fields = ctx.getParam<unknown>(name, itemIndex);
  const out: Record<string, unknown> = {};
  if (!Array.isArray(fields)) return out;

  for (const entry of fields) {
    if (!entry || typeof entry !== 'object') continue;
    const { key, value } = entry as { key?: unknown; value?: unknown };
    if (typeof key !== 'string' || key.trim() === '') continue;
    // No dot notation, unlike Set: a key here is a column, and a column with a
    // dot in it is not one the filter dropdown could ever offer.
    out[key.trim()] = value;
  }
  return out;
}

/** The row a single item contributes: the whole item, or the mapped fields. */
export function rowFromItem(ctx: NodeExecuteContext, itemIndex: number): Record<string, unknown> {
  if (ctx.getParam<string>('mode', itemIndex) === 'fields') return fieldsOf(ctx, 'fields', itemIndex);

  // `$rowId` is this node family's own envelope, added on the way out. Letting
  // it back in would make Get → Insert store a column nobody declared and
  // nobody meant.
  const { $rowId: _ignored, ...json } = ctx.items[itemIndex]?.json ?? {};
  return json;
}

/** The filter, resolved per item so each item can match different rows. */
export function filterFor(ctx: NodeExecuteContext, itemIndex: number): DatatableFilter {
  return parseFilter(
    ctx.getParam<unknown>('filter', itemIndex),
    ctx.getParam<string>('filterCombinator', itemIndex),
  );
}

/**
 * The filter, refusing to run unarmed.
 *
 * An empty filter matches the whole table. Rewriting or removing every row in it
 * is a thing someone might mean, and never a thing they should get by leaving a
 * field blank, so both destructive actions ask for the checkbox first.
 */
function requireFilter(ctx: NodeExecuteContext, itemIndex: number, verb: string): DatatableFilter {
  const filter = filterFor(ctx, itemIndex);
  if (filter.conditions.length > 0 || ctx.getParam<boolean>('allowEmptyFilter', itemIndex) === true) {
    return filter;
  }
  throw new NodeError(
    'ConfigurationError',
    `No filter: this would ${verb} every row in the datatable. Add a condition, or switch on "Without a filter, ${verb} every row".`,
  );
}

function asItems(rows: DatatableRow[]): Item[] {
  // The row's id travels beside its data rather than inside it, so a column
  // called `id` stays the author's own and a later update can still address the
  // row it came from.
  return rows.map((row) => ({ json: { ...row.data, $rowId: row.id } }));
}

/** Every action runs per item: the parameters are expressions, so they differ. */
function eachItem(ctx: NodeExecuteContext): number[] {
  const count = ctx.items.length > 0 ? ctx.items.length : 1;
  return Array.from({ length: count }, (_, index) => index);
}

/**
 * Group the items by the table they are going to.
 *
 * Every parameter here is an expression, so `datatableId` can differ per item —
 * but it almost never does, and one call per group is what makes a hundred
 * inserted items one change set, and so one run of whatever watches the table,
 * rather than a hundred.
 */
function byDatatable(
  ctx: NodeExecuteContext,
  row: (index: number) => Record<string, unknown>,
): Array<{ datatableId: string; rows: Array<Record<string, unknown>> }> {
  const groups: Array<{ datatableId: string; rows: Array<Record<string, unknown>> }> = [];

  for (const index of eachItem(ctx)) {
    const datatableId = requireTableId(ctx, index);
    // Appended to the last group rather than to a map, so items keep the order
    // they arrived in and the stored rows come back in that order too.
    const group = groups.at(-1);
    if (group?.datatableId === datatableId) group.rows.push(row(index));
    else groups.push({ datatableId, rows: [row(index)] });
  }

  return groups;
}

export const executeDatatableInsert: NodeExecute = async (ctx) => {
  const out: Item[] = [];
  for (const group of byDatatable(ctx, (index) => rowFromItem(ctx, index))) {
    const stored = await insertRows({ ...group, source: sourceOf(ctx) });
    out.push(...asItems(stored));
  }
  return [out];
};

export const executeDatatableGet: NodeExecute = async (ctx) => {
  const out: Item[] = [];
  for (const index of eachItem(ctx)) {
    const sortField = ctx.getParam<string>('sortField', index);
    const sort: DatatableSort | null = sortField
      ? { field: sortField, direction: ctx.getParam<string>('sortDirection', index) === 'desc' ? 'desc' : 'asc' }
      : null;

    const { limit, clamped } = clampLimit(ctx.getParam<number>('limit', index));
    if (clamped) ctx.logger.warn(`Asked for more rows than the limit allows; returning ${limit}.`);

    // No match returns nothing at all, rather than one empty item: an item that
    // exists but holds nothing is the harder thing to branch on downstream.
    out.push(
      ...asItems(
        await getRows({ datatableId: requireTableId(ctx, index), filter: filterFor(ctx, index), sort, limit }),
      ),
    );
  }
  return [out];
};

export const executeDatatableUpdate: NodeExecute = async (ctx) => {
  const out: Item[] = [];
  for (const index of eachItem(ctx)) {
    const filter = requireFilter(ctx, index, 'update');

    const stored = await updateRows({
      datatableId: requireTableId(ctx, index),
      filter,
      set: setFields(ctx, index),
      scope: ctx.getParam<string>('scope', index) === 'first' ? 'first' : 'all',
      source: sourceOf(ctx),
    });
    out.push(...asItems(stored));
  }
  return [out];
};

export const executeDatatableDelete: NodeExecute = async (ctx) => {
  const out: Item[] = [];
  for (const index of eachItem(ctx)) {
    const filter = requireFilter(ctx, index, 'delete');

    const deleted = await deleteRows({
      datatableId: requireTableId(ctx, index),
      filter,
      scope: ctx.getParam<string>('scope', index) === 'first' ? 'first' : 'all',
      source: sourceOf(ctx),
    });
    out.push(...asItems(deleted));
  }
  return [out];
};

export const executeDatatableUpsert: NodeExecute = async (ctx) => {
  const out: Item[] = [];

  // Grouped like insert, so a run that upserts a hundred items announces two
  // change sets — the inserts and the updates — instead of two hundred.
  for (const group of byDatatable(ctx, (index) => rowFromItem(ctx, index))) {
    const matchOn = asColumnList(ctx.getParam<unknown>('matchOn'));
    if (matchOn.length === 0) {
      throw new NodeError('ConfigurationError', 'Choose at least one column to match on.');
    }

    const result = await upsertRows({ ...group, matchOn, source: sourceOf(ctx) });
    out.push(...asItems(result.rows));
  }
  return [out];
};

/** The `set` half of an update: mapped fields only, never the whole item. */
function setFields(ctx: NodeExecuteContext, itemIndex: number): Record<string, unknown> {
  const set = fieldsOf(ctx, 'fields', itemIndex);
  if (Object.keys(set).length === 0) {
    throw new NodeError('ConfigurationError', 'Nothing to set: add at least one field.');
  }
  return set;
}

/**
 * A multi-select parameter's value.
 *
 * Stored as a string[], but a graph written before the parameter was multiple —
 * or by hand — can hold a single string, and reading that as one column beats
 * failing.
 */
export function asColumnList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
  if (typeof value === 'string' && value.trim() !== '') return [value.trim()];
  return [];
}
