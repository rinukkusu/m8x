import { delay } from '../../delay.js';
import { NodeError, type Item, type NodeExecute } from '../../types.js';
import { evaluateCondition } from '../conditions.js';
import { readPath } from '../paths.js';

/**
 * The run is held open while a Wait node sleeps, so a long one would burn a
 * worker slot for an hour and die with the execution timeout anyway. Suspending
 * and resuming a run needs state the Execution model does not have yet.
 */
const MAX_WAIT_MS = 5 * 60 * 1000;

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

export const executeSwitch: NodeExecute = async (ctx) => {
    // One branch per rule, plus the fallback when it is switched on. The runner
    // pads this to whatever resolveOutputs says, so the two stay in step.
    const branches: Item[][] = [];
    const fallback = ctx.getParam<boolean>('fallback') === true;
    const allMatches = ctx.getParam<boolean>('allMatches') === true;
    const unmatched: Item[] = [];

    for (let i = 0; i < ctx.items.length; i++) {
      const rules = ctx.getParam<Array<{ key?: unknown; value?: unknown }>>('rules', i) ?? [];
      let matched = false;

      for (let rule = 0; rule < rules.length; rule++) {
        if (!isMatch(rules[rule]?.value)) continue;
        (branches[rule] ??= []).push(ctx.items[i]!);
        matched = true;
        if (!allMatches) break;
      }

      if (!matched) unmatched.push(ctx.items[i]!);
    }

    if (fallback) {
      const rules = ctx.getParam<Array<unknown>>('rules') ?? [];
      branches[rules.length] = unmatched;
    } else if (unmatched.length > 0) {
      ctx.logger.info(`${unmatched.length} items matched no branch and were dropped.`);
    }

    return branches;
  };

/**
 * A batch of the items being looped over.
 *
 * The cursor lives in the runner, not here: `execute` is a plain function and
 * has to stay one, so the state reaches it as an internal parameter the same way
 * Merge learns where its second input starts. `ctx.items` is the whole list
 * being iterated, not the current batch.
 */
export const executeLoopOverItems: NodeExecute = async (ctx) => {
    const size = Math.max(1, Math.floor(Number(ctx.getParam('batchSize') ?? 1)) || 1);
    const cursor = Number(ctx.getParam('__loopCursor') ?? 0);

    // An empty Loop branch is how the runner knows to stop, and this call is the
    // one that hands Done everything the branch produced.
    if (cursor >= ctx.items.length) return [[], ctx.getParam<Item[]>('__loopDone') ?? []];

    return [ctx.items.slice(cursor, cursor + size), []];
  };

export const executeWait: NodeExecute = async (ctx) => {
    const amount = Number(ctx.getParam('amount') ?? 0);
    const unit = ctx.getParam<string>('unit') ?? 'seconds';

    if (!Number.isFinite(amount) || amount < 0) {
      throw new NodeError('ConfigurationError', `"${ctx.getParam('amount')}" is not a length of time.`);
    }

    const ms = amount * (unit === 'minutes' ? 60_000 : 1000);
    if (ms > MAX_WAIT_MS) {
      // Refusing beats silently waiting five minutes instead of the two hours
      // the author asked for and thinks they are getting.
      throw new NodeError(
        'ConfigurationError',
        'A Wait can be at most 5 minutes. The run is held open for the whole wait, so longer than that needs a schedule instead.',
        { requestedMs: ms, maxMs: MAX_WAIT_MS },
      );
    }

    await delay(ms, ctx.signal);
    return [ctx.items];
  };

export const executeNoOp: NodeExecute = async (ctx) => [ctx.items];

export const executeStopAndError: NodeExecute = async (ctx) => {
    const message = ctx.getParam<string>('message', 0) ?? 'The workflow stopped here.';
    throw new NodeError('WorkflowError', message);
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

/**
 * Whether a Switch rule matched.
 *
 * A template resolving to the string "false" is the common case rather than the
 * exotic one — webhook payloads and query strings are all text — so it counts as
 * no, the same reasoning behind the loose equality in conditions.ts.
 */
function isMatch(value: unknown): boolean {
  if (typeof value !== 'string') return Boolean(value);
  const text = value.trim().toLowerCase();
  return text !== '' && text !== 'false' && text !== '0';
}
