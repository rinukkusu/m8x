import { NodeError, type Item, type NodeExecute } from '../../types.js';
import { evaluateCondition } from '../conditions.js';
import { readPath } from '../paths.js';

export const executeIf: NodeExecute = async (ctx) => {
    const matched: Item[] = [];
    const rejected: Item[] = [];

    for (let i = 0; i < ctx.items.length; i++) {
      (evaluateCondition(ctx, i) ? matched : rejected).push(ctx.items[i]!);
    }

    return [matched, rejected];
  };

export const executeFilter: NodeExecute = async (ctx) => {
    const kept: Item[] = [];
    let dropped = 0;

    for (let i = 0; i < ctx.items.length; i++) {
      if (evaluateCondition(ctx, i)) kept.push(ctx.items[i]!);
      else dropped++;
    }

    // Worth logging: "nothing happened downstream" is almost always a filter
    // that quietly ate everything, and the run detail should say so.
    if (dropped > 0) ctx.logger.info(`Filtered out ${dropped} of ${ctx.items.length} items.`);

    return [kept];
  };

export const executeMerge: NodeExecute = async (ctx) => {
    // The runner concatenates both inputs into `items` and records the split
    // point, because a node only ever sees one item array.
    const split = Number(ctx.getParam('__inputSplit') ?? ctx.items.length);
    const left = ctx.items.slice(0, split);
    const right = ctx.items.slice(split);
    const mode = ctx.getParam<string>('mode') ?? 'append';

    if (mode === 'append') return [[...left, ...right]];

    if (mode === 'position') {
      const length = Math.max(left.length, right.length);
      const out: Item[] = [];
      for (let i = 0; i < length; i++) {
        out.push({ json: { ...(left[i]?.json ?? {}), ...(right[i]?.json ?? {}) } });
      }
      return [out];
    }

    const leftKey = ctx.getParam<string>('leftKey');
    const rightKey = ctx.getParam<string>('rightKey') || leftKey;
    if (!leftKey || !rightKey) {
      throw new NodeError('ConfigurationError', 'Combining by field needs a field name on both inputs.');
    }

    const index = new Map<string, Item[]>();
    for (const item of right) {
      const key = String(item.json[rightKey] ?? '');
      const bucket = index.get(key);
      if (bucket) bucket.push(item);
      else index.set(key, [item]);
    }

    const keepUnmatched = ctx.getParam<boolean>('keepUnmatched') === true;
    const out: Item[] = [];

    for (const item of left) {
      const matches = index.get(String(item.json[leftKey] ?? ''));
      if (!matches || matches.length === 0) {
        if (keepUnmatched) out.push(item);
        continue;
      }
      for (const match of matches) {
        out.push({ json: { ...item.json, ...match.json } });
      }
    }

    return [out];
  };

export const executeSplitOut: NodeExecute = async (ctx) => {
    const field = ctx.getParam<string>('field');
    if (!field) throw new NodeError('ConfigurationError', 'No field name is set on this node.');

    const keepParent = ctx.getParam<boolean>('keepParent') === true;
    const out: Item[] = [];

    for (const item of ctx.items) {
      const value = readPath(item.json, field);

      if (!Array.isArray(value)) {
        throw new NodeError(
          'DataError',
          `"${field}" is ${describeType(value)}, not an array.`,
          { field, actual: describeType(value) },
        );
      }

      for (const entry of value) {
        const json = entry && typeof entry === 'object' && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)
          : { value: entry };
        out.push({ json: keepParent ? { ...item.json, ...json } : json });
      }
    }

    return [out];
  };

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'missing';
  return Array.isArray(value) ? 'an array' : `a ${typeof value}`;
}
