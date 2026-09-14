import { Prisma } from '@prisma/client';

import { NodeError } from '../types.js';
import {
  coerceRow,
  parseColumns,
  type DatatableColumn,
} from '../datatables/columns.js';
import {
  DATATABLE_GET_MAX_LIMIT,
  EMPTY_FILTER,
  type DatatableFilter,
  type DatatableSort,
} from '../datatables/filter.js';
import { prisma } from './db.js';
import { filterSql, orderSql } from './datatable-query.js';
import {
  publishDatatableChange,
  type DatatableChangeSet,
  type RowChange,
  type WriteSource,
} from './datatable-changes.js';

/**
 * Datatable storage: the one door every write goes through.
 *
 * Nodes write here, the grid writes here, and anything added later writes here
 * too. That is not tidiness — the change trigger exists because this is the only
 * place a write can happen, and a second path would make it lie.
 *
 * See docs/datatables.md.
 */

export interface Datatable {
  id: string;
  name: string;
  description: string | null;
  columns: DatatableColumn[];
  createdAt: Date;
  updatedAt: Date;
}

export interface DatatableRow {
  id: string;
  data: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * How many rows one call may change.
 *
 * The same ceiling as a read, and for the same reason: a change set becomes one
 * execution carrying one item per row, so an unbounded update would build an
 * execution input nobody can open. Failing with the count beats truncating the
 * change set, which would start a workflow that quietly missed half its work.
 */
export const DATATABLE_WRITE_MAX_ROWS = DATATABLE_GET_MAX_LIMIT;

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function toDatatable(row: {
  id: string;
  name: string;
  description: string | null;
  columns: unknown;
  createdAt: Date;
  updatedAt: Date;
}): Datatable {
  return { ...row, columns: parseColumns(row.columns) };
}

export async function listDatatables(): Promise<Datatable[]> {
  const rows = await prisma.datatable.findMany({ orderBy: { name: 'asc' } });
  return rows.map(toDatatable);
}

export async function getDatatable(id: string): Promise<Datatable | null> {
  const row = await prisma.datatable.findUnique({ where: { id } });
  return row ? toDatatable(row) : null;
}

/**
 * The table, or a failure naming the id.
 *
 * Deleting a datatable a workflow still points at is allowed — warned about in
 * the UI, but allowed, the way a credential is — so this is the error a node
 * hits afterwards, and it has to say which table is missing.
 */
export async function requireDatatable(id: string): Promise<Datatable> {
  const table = await getDatatable(id);
  if (!table) {
    throw new NodeError('datatable_not_found', `No datatable with id "${id}".`, { datatableId: id });
  }
  return table;
}

export async function createDatatable(input: {
  name: string;
  description?: string | null;
  columns?: DatatableColumn[];
}): Promise<Datatable> {
  const row = await prisma.datatable.create({
    data: {
      name: input.name.trim(),
      description: input.description?.trim() || null,
      columns: (input.columns ?? []) as never,
    },
  });
  return toDatatable(row);
}

/**
 * Change a table's metadata.
 *
 * Columns included: adding, removing or renaming one rewrites no rows. A row
 * that predates a column simply lacks the key and reads fill in the default; a
 * removed column stops being shown and stops being offered as a filter field,
 * which is the whole of what removing it means. The data it left behind stays,
 * and comes back if the column does.
 */
export async function updateDatatable(
  id: string,
  input: { name?: string; description?: string | null; columns?: DatatableColumn[] },
): Promise<Datatable> {
  const row = await prisma.datatable.update({
    where: { id },
    data: {
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.description === undefined ? {} : { description: input.description?.trim() || null }),
      ...(input.columns === undefined ? {} : { columns: input.columns as never }),
    },
  });
  return toDatatable(row);
}

export async function deleteDatatable(id: string): Promise<void> {
  await prisma.datatable.delete({ where: { id } });
}

/**
 * The workflows whose graphs name this datatable.
 *
 * For the delete dialog: deleting is allowed, but doing it without being told
 * what it breaks is not. The id appears verbatim in the node parameters, so a
 * containment check on the stored graph finds every reference without loading
 * and walking each one.
 */
export async function workflowsUsingDatatable(id: string): Promise<Array<{ id: string; name: string }>> {
  return prisma.$queryRaw<Array<{ id: string; name: string }>>`
    SELECT "id", "name" FROM "Workflow" WHERE "graph"::text LIKE ${`%${id}%`} ORDER BY "name" ASC
  `;
}

// ---------------------------------------------------------------------------
// Reading rows
// ---------------------------------------------------------------------------

export interface GetRowsInput {
  datatableId: string;
  filter?: DatatableFilter;
  sort?: DatatableSort | null;
  limit?: number;
  offset?: number;
}

export async function getRows(input: GetRowsInput): Promise<DatatableRow[]> {
  const table = await requireDatatable(input.datatableId);
  const where = filterSql(table.id, input.filter ?? EMPTY_FILTER);
  const order = orderSql(table.columns, input.sort ?? null);
  const limit = Math.min(input.limit ?? DATATABLE_GET_MAX_LIMIT, DATATABLE_GET_MAX_LIMIT);

  return prisma.$queryRaw<DatatableRow[]>`
    SELECT "id", "data", "createdAt", "updatedAt"
    FROM "DatatableRow"
    WHERE ${where}
    ORDER BY ${order}
    LIMIT ${limit} OFFSET ${input.offset ?? 0}
  `;
}

export async function countRows(datatableId: string, filter?: DatatableFilter): Promise<number> {
  const where = filterSql(datatableId, filter ?? EMPTY_FILTER);
  const [row] = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*) AS count FROM "DatatableRow" WHERE ${where}
  `;
  return Number(row?.count ?? 0);
}

/**
 * The rows a write is about to touch, refusing to start if there are too many.
 *
 * One row over the ceiling is enough to know, so the query asks for one more
 * than it will accept rather than counting the whole match.
 */
async function matchedRows(
  table: Datatable,
  filter: DatatableFilter,
  scope: 'first' | 'all',
): Promise<DatatableRow[]> {
  const limit = scope === 'first' ? 1 : DATATABLE_WRITE_MAX_ROWS + 1;
  const rows = await prisma.$queryRaw<DatatableRow[]>`
    SELECT "id", "data", "createdAt", "updatedAt"
    FROM "DatatableRow"
    WHERE ${filterSql(table.id, filter)}
    ORDER BY "createdAt" ASC
    LIMIT ${limit}
  `;

  if (rows.length > DATATABLE_WRITE_MAX_ROWS) {
    throw new NodeError(
      'datatable_too_many_rows',
      `That matches more than ${DATATABLE_WRITE_MAX_ROWS} rows. Narrow the filter, or do it in the datatable view.`,
      { datatableId: table.id, limit: DATATABLE_WRITE_MAX_ROWS },
    );
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Writing rows
// ---------------------------------------------------------------------------

export interface WriteOptions {
  source?: WriteSource | null;
  /** Suppress triggers. The grid's bulk-edit escape hatch; never a node's. */
  silent?: boolean;
}

async function announce(
  datatableId: string,
  event: DatatableChangeSet['event'],
  rows: RowChange[],
  options: WriteOptions,
): Promise<void> {
  await publishDatatableChange({
    datatableId,
    event,
    rows,
    source: options.source ?? null,
    silent: options.silent,
  });
}

export async function insertRows(
  input: { datatableId: string; rows: Array<Record<string, unknown>> } & WriteOptions,
): Promise<DatatableRow[]> {
  const table = await requireDatatable(input.datatableId);
  const rows = input.rows.map((row) => coerceRow(table.columns, row));
  if (rows.length === 0) return [];

  await assertUnique(table, rows);

  const created = await prisma.datatableRow.createManyAndReturn({
    data: rows.map((data) => ({ datatableId: table.id, data: data as never })),
    select: { id: true, data: true, createdAt: true, updatedAt: true },
  });

  const stored = created as unknown as DatatableRow[];
  await announce(table.id, 'insert', stored.map((row) => ({ rowId: row.id, row: row.data })), input);
  return stored;
}

export async function updateRows(
  input: {
    datatableId: string;
    filter: DatatableFilter;
    set: Record<string, unknown>;
    scope?: 'first' | 'all';
  } & WriteOptions,
): Promise<DatatableRow[]> {
  const table = await requireDatatable(input.datatableId);
  const matched = await matchedRows(table, input.filter, input.scope ?? 'all');
  if (matched.length === 0) return [];

  // Merged and coerced in here rather than with a `data || patch` in SQL, so the
  // result goes through exactly the same checks a fresh row does — types, the
  // required columns, the size cap — and so the change set can carry what each
  // row was before.
  const next = matched.map((row) => ({
    row,
    data: coerceRow(table.columns, { ...row.data, ...input.set }),
  }));

  const updated = await prisma.$transaction(
    next.map((entry) =>
      prisma.datatableRow.update({
        where: { id: entry.row.id },
        data: { data: entry.data as never },
        select: { id: true, data: true, createdAt: true, updatedAt: true },
      }),
    ),
  );

  const stored = updated as unknown as DatatableRow[];
  await announce(
    table.id,
    'update',
    next.map((entry) => ({ rowId: entry.row.id, row: entry.data, previous: entry.row.data })),
    input,
  );
  return stored;
}

export async function deleteRows(
  input: { datatableId: string; filter: DatatableFilter; scope?: 'first' | 'all' } & WriteOptions,
): Promise<DatatableRow[]> {
  const table = await requireDatatable(input.datatableId);
  const matched = await matchedRows(table, input.filter, input.scope ?? 'all');
  if (matched.length === 0) return [];

  await prisma.datatableRow.deleteMany({ where: { id: { in: matched.map((row) => row.id) } } });

  // The rows are gone, but the workflow still gets to see what they held: a
  // hard delete is only defensible because nothing about the row is lost to the
  // execution that caused it.
  await announce(
    table.id,
    'delete',
    matched.map((row) => ({ rowId: row.id, previous: row.data })),
    input,
  );
  return matched;
}

export interface UpsertResult {
  rows: DatatableRow[];
  inserted: number;
  updated: number;
}

/**
 * Match on the node's key columns, then update or insert.
 *
 * The lock is what makes two runs of the same node safe: without it, both find
 * nothing and both insert. It is taken on the key's value, so unrelated rows
 * never wait for each other.
 *
 * It is also as far as this goes, and the node says so. Two *different* nodes
 * keying one table differently can still each insert what the other would have
 * matched — a per-table unique index would stop that, at the price of generating
 * DDL at runtime.
 */
export async function upsertRows(
  input: {
    datatableId: string;
    matchOn: string[];
    rows: Array<Record<string, unknown>>;
  } & WriteOptions,
): Promise<UpsertResult> {
  const table = await requireDatatable(input.datatableId);
  if (input.matchOn.length === 0) {
    throw new NodeError('datatable_no_match_columns', 'Upsert needs at least one column to match on.');
  }

  const inserts: RowChange[] = [];
  const updates: RowChange[] = [];
  const rows: DatatableRow[] = [];

  for (const raw of input.rows) {
    const data = coerceRow(table.columns, raw);
    const missing = input.matchOn.filter((key) => data[key] === undefined);
    if (missing.length > 0) {
      throw new NodeError(
        'datatable_match_value_missing',
        `Cannot match on ${missing.join(', ')}: the item has no value for it.`,
        { matchOn: input.matchOn },
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      const key = `${table.id}:${input.matchOn.join(',')}:${JSON.stringify(input.matchOn.map((column) => data[column]))}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;

      const filter: DatatableFilter = {
        combinator: 'and',
        conditions: input.matchOn.map((column) => ({
          field: column,
          operator: 'equals' as const,
          value: data[column],
        })),
      };

      const [existing] = await tx.$queryRaw<DatatableRow[]>`
        SELECT "id", "data", "createdAt", "updatedAt"
        FROM "DatatableRow"
        WHERE ${filterSql(table.id, filter)}
        ORDER BY "createdAt" ASC
        LIMIT 1
      `;

      if (!existing) {
        const created = await tx.datatableRow.create({
          data: { datatableId: table.id, data: data as never },
          select: { id: true, data: true, createdAt: true, updatedAt: true },
        });
        return { row: created as unknown as DatatableRow, previous: null };
      }

      const merged = coerceRow(table.columns, { ...existing.data, ...data });
      const updated = await tx.datatableRow.update({
        where: { id: existing.id },
        data: { data: merged as never },
        select: { id: true, data: true, createdAt: true, updatedAt: true },
      });
      return { row: updated as unknown as DatatableRow, previous: existing.data };
    });

    rows.push(result.row);
    if (result.previous) {
      updates.push({ rowId: result.row.id, row: result.row.data, previous: result.previous });
    } else {
      inserts.push({ rowId: result.row.id, row: result.row.data });
    }
  }

  // Two change sets rather than one mixed event, so a trigger listening only for
  // inserts hears only the inserts.
  await announce(table.id, 'insert', inserts, input);
  await announce(table.id, 'update', updates, input);

  return { rows, inserted: inserts.length, updated: updates.length };
}

/**
 * The backstop behind a column declared unique.
 *
 * Not a constraint: enforcing it in the database would mean an expression index
 * per column per table, generated at runtime. This catches the duplicate an
 * insert would create, both against what is stored and within the batch itself.
 */
async function assertUnique(table: Datatable, rows: Array<Record<string, unknown>>): Promise<void> {
  const unique = table.columns.filter((column) => column.unique);
  if (unique.length === 0) return;

  for (const column of unique) {
    const values = rows
      .map((row) => row[column.key])
      .filter((value): value is NonNullable<unknown> => value !== undefined && value !== null);
    if (values.length === 0) continue;

    const texts = values.map((value) => (typeof value === 'object' ? JSON.stringify(value) : String(value)));
    const duplicate = texts.find((text, index) => texts.indexOf(text) !== index);
    if (duplicate !== undefined) {
      throw new NodeError(
        'datatable_duplicate',
        `Column "${column.name}" is unique, and "${duplicate}" appears twice in what is being inserted.`,
        { column: column.key },
      );
    }

    const [clash] = await prisma.$queryRaw<Array<{ value: string }>>`
      SELECT jsonb_extract_path_text("data", ${column.key}) AS value
      FROM "DatatableRow"
      WHERE "datatableId" = ${table.id}
        AND jsonb_extract_path_text("data", ${column.key}) IN (${Prisma.join(texts)})
      LIMIT 1
    `;
    if (clash) {
      throw new NodeError(
        'datatable_duplicate',
        `Column "${column.name}" is unique, and a row with "${clash.value}" already exists.`,
        { column: column.key },
      );
    }
  }
}
