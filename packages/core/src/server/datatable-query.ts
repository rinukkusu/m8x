import { Prisma } from '@prisma/client';

import { NodeError } from '../types.js';
import type { DatatableColumn } from '../datatables/columns.js';
import type { DatatableCondition, DatatableFilter, DatatableSort } from '../datatables/filter.js';

/**
 * Turning a filter into SQL.
 *
 * Prisma's JSON filters cover equality and little else — no regex, no "does not
 * contain", no numeric comparison that survives a string in the column — so the
 * predicates are built here instead. Every field name and every value is a bound
 * parameter, so a column called `"; drop table` is a column name and nothing
 * more.
 *
 * The semantics deliberately mirror `nodes/conditions.ts`, so a filter and an If
 * node asking the same question agree. The one place they cannot is numeric
 * comparison: conditions.ts throws when a value is not a number, and a row in
 * the middle of a result set has no way to throw. A row whose value is not
 * numeric simply does not match.
 */

const NUMERIC_TEXT = '^\\s*-?[0-9]+(\\.[0-9]+)?\\s*$';

/** The row's value for a field, as text. NULL when the key is absent. */
function fieldText(field: string): Prisma.Sql {
  return Prisma.sql`jsonb_extract_path_text("data", ${field})`;
}

/** The same value as a number, or NULL when it does not look like one. */
function fieldNumber(field: string): Prisma.Sql {
  const text = fieldText(field);
  return Prisma.sql`(CASE WHEN ${text} ~ ${NUMERIC_TEXT} THEN (${text})::numeric END)`;
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function conditionSql(condition: DatatableCondition): Prisma.Sql {
  const { field, operator } = condition;
  const text = fieldText(field);
  const value = asText(condition.value);

  switch (operator) {
    case 'isEmpty':
      // '[]' and '{}' count as empty here because they do in conditions.ts.
      return Prisma.sql`COALESCE(btrim(${text}), '') IN ('', '[]', '{}')`;
    case 'isNotEmpty':
      return Prisma.sql`COALESCE(btrim(${text}), '') NOT IN ('', '[]', '{}')`;
    case 'isTrue':
      return Prisma.sql`${text} = 'true'`;
    case 'isFalse':
      return Prisma.sql`${text} = 'false'`;

    case 'equals':
      return Prisma.sql`${text} = ${value}`;
    case 'notEquals':
      // A row missing the key is not equal to anything, so it matches. Leaving
      // the NULL to propagate would silently drop those rows instead.
      return Prisma.sql`${text} IS DISTINCT FROM ${value}`;

    case 'contains':
      return Prisma.sql`strpos(COALESCE(${text}, ''), ${value}) > 0`;
    case 'notContains':
      return Prisma.sql`strpos(COALESCE(${text}, ''), ${value}) = 0`;
    case 'startsWith':
      return Prisma.sql`starts_with(COALESCE(${text}, ''), ${value})`;
    case 'endsWith':
      return Prisma.sql`right(COALESCE(${text}, ''), length(${value})) = ${value}`;
    case 'regex':
      return Prisma.sql`COALESCE(${text}, '') ~ ${value}`;

    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const number = Number(asText(condition.value));
      if (!Number.isFinite(number)) {
        // Configuration, not data: the comparison value came from the node, so
        // failing loudly here is the diagnosable option.
        throw new NodeError(
          'ConfigurationError',
          `Cannot compare "${field}" numerically against ${JSON.stringify(condition.value)}.`,
          { field, operator },
        );
      }
      const left = fieldNumber(field);
      if (operator === 'gt') return Prisma.sql`${left} > ${number}`;
      if (operator === 'gte') return Prisma.sql`${left} >= ${number}`;
      if (operator === 'lt') return Prisma.sql`${left} < ${number}`;
      return Prisma.sql`${left} <= ${number}`;
    }

    default:
      throw new NodeError('ConfigurationError', `Unknown operator "${String(operator)}".`);
  }
}

/**
 * The whole filter as one boolean expression, scoped to its datatable.
 *
 * An empty condition list matches every row in the table. That is what makes
 * "delete everything in here" expressible, and it is exactly why the delete node
 * asks before running with one.
 */
export function filterSql(datatableId: string, filter: DatatableFilter): Prisma.Sql {
  const scope = Prisma.sql`"datatableId" = ${datatableId}`;
  if (filter.conditions.length === 0) return scope;

  const parts = filter.conditions.map(conditionSql);
  const joined = Prisma.join(parts, filter.combinator === 'or' ? ' OR ' : ' AND ');
  return Prisma.sql`${scope} AND (${joined})`;
}

/**
 * Order rows by a column, numerically when the column is declared as a number.
 *
 * Without the declaration this would sort 9 after 42, because the underlying
 * value is text. Dates are stored as ISO-8601 in UTC precisely so that they do
 * not need this treatment.
 */
export function orderSql(columns: DatatableColumn[], sort: DatatableSort | null): Prisma.Sql {
  if (!sort) return Prisma.sql`"createdAt" DESC`;

  const column = columns.find((entry) => entry.key === sort.field);
  const expression = column?.type === 'number' ? fieldNumber(sort.field) : fieldText(sort.field);
  // NULLS LAST in both directions: a row missing the column is not the most
  // interesting row in the table.
  return sort.direction === 'desc'
    ? Prisma.sql`${expression} DESC NULLS LAST`
    : Prisma.sql`${expression} ASC NULLS LAST`;
}
