import { COMPARISON_OPERATORS } from '../nodes/descriptors/shared.js';

/**
 * The question `get`, `update` and `delete` all ask.
 *
 * One definition rather than three, for the same reason `conditionParams` is
 * shared by If, Filter and Switch: three hand-written copies drift apart the
 * first time an operator is added.
 */

export type DatatableOperator = (typeof COMPARISON_OPERATORS)[number]['value'];

/** Operators that compare against nothing, so the value input is hidden. */
export const UNARY_OPERATORS: DatatableOperator[] = ['isEmpty', 'isNotEmpty', 'isTrue', 'isFalse'];

export interface DatatableCondition {
  /** A column key, or any key in the row — the dropdown falls back to text. */
  field: string;
  operator: DatatableOperator;
  value?: unknown;
}

export interface DatatableFilter {
  /** How the conditions combine. An empty condition list matches everything. */
  combinator: 'and' | 'or';
  conditions: DatatableCondition[];
}

export const EMPTY_FILTER: DatatableFilter = { combinator: 'and', conditions: [] };

export interface DatatableSort {
  field: string;
  direction: 'asc' | 'desc';
}

/** Defaults and ceilings for a read. A larger limit is clamped, not refused. */
export const DATATABLE_GET_DEFAULT_LIMIT = 50;
export const DATATABLE_GET_MAX_LIMIT = 1000;

export function clampLimit(requested: unknown): { limit: number; clamped: boolean } {
  const asked = Number(requested);
  if (!Number.isFinite(asked) || asked <= 0) {
    return { limit: DATATABLE_GET_DEFAULT_LIMIT, clamped: false };
  }
  const limit = Math.min(Math.floor(asked), DATATABLE_GET_MAX_LIMIT);
  return { limit, clamped: limit < Math.floor(asked) };
}

/**
 * Read a filter back out of node parameters.
 *
 * The inspector stores rows of `{ field, operator, value }`; a row with no
 * field is one the author started and left, and dropping it beats matching
 * everything or failing the node.
 */
export function parseFilter(value: unknown, combinator: unknown = 'and'): DatatableFilter {
  const rows = Array.isArray(value) ? value : [];
  const conditions: DatatableCondition[] = [];

  for (const entry of rows) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    const field = typeof raw.field === 'string' ? raw.field.trim() : '';
    if (!field) continue;

    const operator = COMPARISON_OPERATORS.some((option) => option.value === raw.operator)
      ? (raw.operator as DatatableOperator)
      : 'equals';

    conditions.push({ field, operator, value: raw.value });
  }

  return { combinator: combinator === 'or' ? 'or' : 'and', conditions };
}
