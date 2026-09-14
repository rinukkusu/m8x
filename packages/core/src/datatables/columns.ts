import { NodeError } from '../types.js';

/**
 * What a datatable column is, and what declaring one is worth.
 *
 * Columns are metadata: they drive the grid, the filter dropdowns, and the
 * coercion below. They are not the physical layout, so adding, renaming or
 * removing one writes a single `Datatable` row and touches no data.
 *
 * This file has no database import on purpose. The editor renders the column
 * form from it and the worker coerces with it, and neither should pull in the
 * other's dependencies to do so.
 */

export type DatatableColumnType = 'string' | 'number' | 'boolean' | 'datetime' | 'json';

export const DATATABLE_COLUMN_TYPES: Array<{ label: string; value: DatatableColumnType }> = [
  { label: 'Text', value: 'string' },
  { label: 'Number', value: 'number' },
  { label: 'True/false', value: 'boolean' },
  { label: 'Date & time', value: 'datetime' },
  { label: 'JSON', value: 'json' },
];

export interface DatatableColumn {
  /** The key in the row's data. */
  key: string;
  /** What the grid and the filter dropdown show. */
  name: string;
  type: DatatableColumnType;
  required?: boolean;
  /** Checked on insert as a backstop. The real guard on upsert is its lock. */
  unique?: boolean;
  /** Filled in when a write leaves the key out, and when a row predates it. */
  default?: unknown;
}

/** Serialised JSON per row. Mirrors the NodeRun payload cap. */
export const DATATABLE_ROW_MAX_BYTES = 64 * 1024;

/** Keys have to survive being a JSON key and a dropdown value, nothing more. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidColumnKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/**
 * Read the `columns` Json back into columns.
 *
 * Anything unrecognised is dropped rather than thrown over: this runs on every
 * read of every datatable, the grid included, and metadata written by a newer
 * version of m8x should not make the page fail to render.
 */
export function parseColumns(value: unknown): DatatableColumn[] {
  if (!Array.isArray(value)) return [];

  const columns: DatatableColumn[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    const key = typeof raw.key === 'string' ? raw.key : null;
    if (!key || !isValidColumnKey(key) || seen.has(key)) continue;

    const type = DATATABLE_COLUMN_TYPES.some((option) => option.value === raw.type)
      ? (raw.type as DatatableColumnType)
      : 'string';

    seen.add(key);
    columns.push({
      key,
      name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : key,
      type,
      required: raw.required === true,
      unique: raw.unique === true,
      default: raw.default,
    });
  }

  return columns;
}

/**
 * Coerce a written row against the declared columns.
 *
 * Declared columns are coerced to their type, a required column that is missing
 * or uncoercible fails, and every other key is kept as it arrived.
 *
 * Coercing is what keeps a filter honest: `gt` on a number column has to be
 * comparing numbers, or "9" > "42" is true. Keeping the undeclared keys is what
 * stops a workflow dying the day the API upstream adds a field — that cost
 * would land on whoever is least able to predict it.
 */
export function coerceRow(
  columns: DatatableColumn[],
  data: Record<string, unknown>,
): Record<string, unknown> {
  const row: Record<string, unknown> = { ...data };

  for (const column of columns) {
    const present = Object.prototype.hasOwnProperty.call(row, column.key);
    const raw = present ? row[column.key] : column.default;

    if (raw === undefined || raw === null || raw === '') {
      if (column.required) {
        throw new NodeError(
          'datatable_column_required',
          `Column "${column.name}" is required and was empty.`,
          { column: column.key },
        );
      }
      // An absent optional column stays absent rather than becoming null, so a
      // row written before the column existed and one written after it look the
      // same to whatever reads them.
      if (present) delete row[column.key];
      continue;
    }

    row[column.key] = coerceValue(column, raw);
  }

  const size = Buffer.byteLength(JSON.stringify(row) ?? 'null', 'utf8');
  if (size > DATATABLE_ROW_MAX_BYTES) {
    throw new NodeError(
      'datatable_row_too_large',
      `A row is ${Math.round(size / 1024)} kB, over the ${DATATABLE_ROW_MAX_BYTES / 1024} kB limit.`,
      { size },
    );
  }

  return row;
}

function coerceValue(column: DatatableColumn, raw: unknown): unknown {
  switch (column.type) {
    case 'number': {
      const value = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(value)) throw typeError(column, raw, 'a number');
      return value;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      const text = String(raw).trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(text)) return true;
      if (['false', '0', 'no', 'off'].includes(text)) return false;
      throw typeError(column, raw, 'true or false');
    }
    case 'datetime': {
      const value = raw instanceof Date ? raw : new Date(String(raw));
      if (Number.isNaN(value.getTime())) throw typeError(column, raw, 'a date');
      // ISO-8601 in UTC, so sorting the text and sorting the instants agree and
      // a filter never has to parse every row to compare two of them.
      return value.toISOString();
    }
    case 'json': {
      if (typeof raw !== 'string') return raw;
      try {
        return JSON.parse(raw);
      } catch {
        throw typeError(column, raw, 'JSON');
      }
    }
    default:
      return typeof raw === 'string' ? raw : String(raw);
  }
}

function typeError(column: DatatableColumn, raw: unknown, expected: string): NodeError {
  const shown = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return new NodeError(
    'datatable_column_type',
    `Column "${column.name}" expects ${expected}, got ${String(shown).slice(0, 60)}.`,
    { column: column.key },
  );
}
