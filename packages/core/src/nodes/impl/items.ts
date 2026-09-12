import { NodeError, type Item, type NodeExecute } from '../../types.js';
import { readPath } from '../paths.js';

/**
 * The nodes that reshape a list of items rather than route it.
 *
 * All pure functions of `ctx.items`: no credentials, no network, no clock. They
 * live apart from flow.ts so that file stays about branching.
 */

export const executeLimit: NodeExecute = async (ctx) => {
  const max = Math.max(0, Math.floor(Number(ctx.getParam('maxItems') ?? 0)));
  if (!Number.isFinite(max)) {
    throw new NodeError('ConfigurationError', `"${ctx.getParam('maxItems')}" is not a number of items.`);
  }

  if (ctx.items.length <= max) return [ctx.items];

  const keep = ctx.getParam<string>('keep') ?? 'first';
  const kept = keep === 'last' ? ctx.items.slice(-max) : ctx.items.slice(0, max);
  ctx.logger.info(`Kept ${kept.length} of ${ctx.items.length} items.`);
  return [kept];
};

export const executeSort: NodeExecute = async (ctx) => {
  const items = [...ctx.items];

  if (ctx.getParam<string>('mode') === 'random') {
    // Fisher-Yates. Array.sort with a random comparator is not a shuffle.
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return [items];
  }

  const rows = (ctx.getParam<Array<{ key?: unknown; value?: unknown }>>('fields') ?? [])
    .map((row) => ({
      field: typeof row.key === 'string' ? row.key.trim() : '',
      descending: String(row.value ?? 'asc').trim().toLowerCase().startsWith('desc'),
    }))
    .filter((row) => row.field !== '');

  if (rows.length === 0) {
    throw new NodeError('ConfigurationError', 'No field to sort by is set on this node.');
  }

  // Array.prototype.sort is stable, so rows later in the list break ties from
  // the ones before them without any extra bookkeeping.
  items.sort((left, right) => {
    for (const row of rows) {
      const order = compareValues(readPath(left.json, row.field), readPath(right.json, row.field));
      if (order !== 0) return row.descending ? -order : order;
    }
    return 0;
  });

  return [items];
};

export const executeRemoveDuplicates: NodeExecute = async (ctx) => {
  const mode = ctx.getParam<string>('mode') ?? 'allFields';
  const fields = mode === 'fields' ? splitFields(ctx.getParam<string>('fields')) : [];

  if (mode === 'fields' && fields.length === 0) {
    throw new NodeError('ConfigurationError', 'No fields to compare are set on this node.');
  }

  const seen = new Set<string>();
  const kept: Item[] = [];

  for (let i = 0; i < ctx.items.length; i++) {
    const item = ctx.items[i]!;
    let key: string;

    if (mode === 'expression') key = String(ctx.getParam('key', i) ?? '');
    else if (mode === 'fields') key = JSON.stringify(fields.map((field) => readPath(item.json, field) ?? null));
    else key = stableJson(item.json);

    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(item);
  }

  const dropped = ctx.items.length - kept.length;
  if (dropped > 0) ctx.logger.info(`Dropped ${dropped} duplicate items.`);

  return [kept];
};

export const executeAggregate: NodeExecute = async (ctx) => {
  const outputField = (ctx.getParam<string>('outputField') || 'data').trim();

  if (ctx.getParam<string>('mode') === 'allItems') {
    return [[{ json: { [outputField]: ctx.items.map((item) => item.json) } }]];
  }

  const field = ctx.getParam<string>('field');
  if (!field) throw new NodeError('ConfigurationError', 'No field to collect is set on this node.');

  const values = ctx.items.map((item) => readPath(item.json, field) ?? null);
  return [[{ json: { [outputField]: values } }]];
};

type Aggregation = { field: string; operation: string };

const OPERATIONS = new Set(['count', 'sum', 'avg', 'min', 'max', 'concat']);

export const executeSummarize: NodeExecute = async (ctx) => {
  const groupBy = splitFields(ctx.getParam<string>('groupBy'));
  const aggregations: Aggregation[] = (
    ctx.getParam<Array<{ key?: unknown; value?: unknown }>>('aggregations') ?? []
  )
    .map((row) => ({
      field: typeof row.key === 'string' ? row.key.trim() : '',
      operation: String(row.value ?? '').trim().toLowerCase(),
    }))
    .filter((row) => row.field !== '');

  for (const aggregation of aggregations) {
    if (!OPERATIONS.has(aggregation.operation)) {
      throw new NodeError(
        'ConfigurationError',
        `"${aggregation.operation}" is not something Summarize can work out. Use one of ${[...OPERATIONS].join(', ')}.`,
        { field: aggregation.field },
      );
    }
  }

  // A Map keeps the groups in the order they were first seen, so the output
  // follows the input rather than an arbitrary hash order.
  const groups = new Map<string, { keys: Record<string, unknown>; items: Item[] }>();

  for (const item of ctx.items) {
    const keys: Record<string, unknown> = {};
    for (const field of groupBy) keys[field] = readPath(item.json, field) ?? null;

    const id = JSON.stringify(groupBy.map((field) => keys[field]));
    const group = groups.get(id);
    if (group) group.items.push(item);
    else groups.set(id, { keys, items: [item] });
  }

  const out: Item[] = [];
  for (const group of groups.values()) {
    const json: Record<string, unknown> = { ...group.keys, count: group.items.length };
    for (const aggregation of aggregations) {
      json[`${aggregation.operation}_${aggregation.field}`] = summarise(group.items, aggregation);
    }
    out.push({ json });
  }

  return [out];
};

function summarise(items: Item[], aggregation: Aggregation): unknown {
  const values = items.map((item) => readPath(item.json, aggregation.field));

  if (aggregation.operation === 'count') {
    return values.filter((value) => value !== undefined && value !== null).length;
  }
  if (aggregation.operation === 'concat') {
    return values.filter((value) => value !== undefined && value !== null).join(', ');
  }

  // Anything that is not a number is left out rather than turned into NaN: a
  // single blank cell should not poison the total for the whole group.
  const numbers = values.map(toNumber).filter((value): value is number => value !== null);
  if (numbers.length === 0) return null;

  switch (aggregation.operation) {
    case 'sum':
      return numbers.reduce((total, value) => total + value, 0);
    case 'avg':
      return numbers.reduce((total, value) => total + value, 0) / numbers.length;
    case 'min':
      return Math.min(...numbers);
    default:
      return Math.max(...numbers);
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Numbers compare as numbers, everything else as text. Missing values sort last. */
function compareValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === undefined || left === null) return 1;
  if (right === undefined || right === null) return -1;

  const a = toNumber(left);
  const b = toNumber(right);
  if (a !== null && b !== null) return a - b;

  return String(left).localeCompare(String(right));
}

function splitFields(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((field) => field.trim())
    .filter((field) => field !== '');
}

/**
 * Key order must not decide whether two items are duplicates, and it does with
 * a plain JSON.stringify: two items built by different branches can carry the
 * same fields in a different order.
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
}
