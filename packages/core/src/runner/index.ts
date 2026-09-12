import { resolveValue, type ExpressionScope } from '../expressions.js';
import { describeError, errorFingerprint, type ExtractedError } from '../fingerprint.js';
import { indexGraph, topologicalOrder, validateGraph } from '../graph.js';
import { requireNodeDefinition } from '../nodes/executors.js';
import { isParamVisible, paramUsesExpressions, resolveOutputs, validateParams } from '../nodes/index.js';
import {
  NodeError,
  type Graph,
  type GraphNode,
  type Item,
  type NodeDefinition,
  type NodeExecuteContext,
  type NodeOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// Events
//
// The runner never touches the database. It emits events and something else
// decides what to store. That keeps it testable without a Postgres instance,
// and it is what will let the editor stream a live run later without a second
// code path.
// ---------------------------------------------------------------------------

export type NodeRunStatus = 'success' | 'failed' | 'skipped';

export interface NodeStartEvent {
  type: 'nodeStart';
  nodeId: string;
  nodeName: string;
  nodeType: string;
  attempt: number;
  sequence: number;
  input: Item[];
  startedAt: Date;
}

export interface NodeFinishEvent {
  type: 'nodeFinish';
  nodeId: string;
  nodeName: string;
  nodeType: string;
  attempt: number;
  sequence: number;
  status: NodeRunStatus;
  input: Item[];
  output?: Item[];
  error?: ExtractedError;
  durationMs: number;
  finishedAt: Date;
  /** Set when this attempt failed but another one will follow. */
  willRetry?: boolean;
}

export interface LogEvent {
  type: 'log';
  nodeId: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  at: Date;
}

export type RunEvent = NodeStartEvent | NodeFinishEvent | LogEvent;

// ---------------------------------------------------------------------------
// Inputs and result
// ---------------------------------------------------------------------------

export interface RunnerContext {
  executionId: string;
  workflowId: string;
  /** How the run started, used for the `$execution.mode` expression variable. */
  mode: string;
  graph: Graph;
  /** Items handed to the entry node, e.g. a webhook body. */
  seedItems: Item[];
  /**
   * Start here instead of at the graph's entry nodes. Used by retry-from-node:
   * the outputs of everything upstream come from `restoredOutputs`.
   */
  startNodeId?: string;
  /** Node outputs recovered from a previous execution, keyed by node id. */
  restoredOutputs?: Record<string, Item[][]>;
  signal: AbortSignal;
  /** Decrypt a credential by its id. Injected so core stays database-free. */
  loadCredential(credentialId: string): Promise<Record<string, string> | null>;
  emit(event: RunEvent): void | Promise<void>;
}

export interface RunFailure {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  errorType: string;
  message: string;
  fingerprint: string;
}

export interface RunResult {
  status: 'success' | 'failed' | 'cancelled';
  failure?: RunFailure;
  /** Final output of every node that ran, by node id. */
  outputs: Record<string, Item[][]>;
  durationMs: number;
}

const DEFAULT_RETRY_BACKOFF_MS = 1000;

/**
 * Internal parameters the runner injects for nodes that need to know something
 * about their own wiring. They are prefixed so they can never collide with a
 * real parameter name from a node's schema.
 */
const INTERNAL_INPUT_SPLIT = '__inputSplit';
const INTERNAL_NODE_OUTPUTS = '__nodeOutputs';

export async function runWorkflow(ctx: RunnerContext): Promise<RunResult> {
  const startedAt = Date.now();

  const issues = validateGraph(ctx.graph).filter((issue) => issue.level === 'error');
  if (issues.length > 0) {
    return {
      status: 'failed',
      durationMs: Date.now() - startedAt,
      outputs: {},
      failure: {
        nodeId: issues[0]!.nodeId ?? '',
        nodeName: '',
        nodeType: '',
        errorType: 'GraphError',
        message: issues[0]!.message,
        fingerprint: errorFingerprint({
          nodeType: 'workflow',
          errorType: 'GraphError',
          message: issues[0]!.message,
        }),
      },
    };
  }

  const index = indexGraph(ctx.graph);
  const order = topologicalOrder(ctx.graph);
  const outputs: Record<string, Item[][]> = { ...(ctx.restoredOutputs ?? {}) };
  /** Nodes that did not run, so downstream nodes know the branch was not taken. */
  const skipped = new Set<string>();
  const now = new Date().toISOString();

  let sequence = 0;
  let startReached = ctx.startNodeId === undefined;

  for (const node of order) {
    if (ctx.signal.aborted) {
      return { status: 'cancelled', outputs, durationMs: Date.now() - startedAt };
    }

    if (ctx.startNodeId !== undefined && !startReached) {
      // Everything before the retry point keeps its restored output and is not
      // re-run. Side effects upstream already happened; repeating them would be
      // the wrong thing.
      if (node.id === ctx.startNodeId) startReached = true;
      else {
        if (!(node.id in outputs)) skipped.add(node.id);
        continue;
      }
    }

    const definition = requireNodeDefinition(node.type);
    const incoming = index.incoming.get(node.id) ?? [];

    if (node.disabled) {
      // A disabled node is a pass-through, not a wall. Turning one off to test
      // around it should not sever the rest of the workflow.
      const gathered = gatherInput(incoming, outputs, skipped);

      // Unless there was nothing to pass through: a disabled node sitting on a
      // branch the If rejected must stay skipped, or it would hand the rest of
      // that branch an empty input and let it fire its side effects.
      if (!gathered.anyBranchActive && incoming.length > 0) {
        skipped.add(node.id);
        await ctx.emit(makeSkipEvent(node, sequence++, 'upstream branch was not taken'));
        continue;
      }

      outputs[node.id] = [gathered.items];
      await ctx.emit(makeSkipEvent(node, sequence++, 'disabled'));
      continue;
    }

    let input: Item[];
    let inputSplit = 0;

    if (definition.inputs === 0) {
      // Trigger. Only the one the run actually started from produces items.
      const isEntryPoint = ctx.startNodeId ? node.id === ctx.startNodeId : isRunEntryPoint(node, ctx, order);
      if (!isEntryPoint) {
        skipped.add(node.id);
        await ctx.emit(makeSkipEvent(node, sequence++, 'not the trigger for this run'));
        continue;
      }
      input = ctx.seedItems;
    } else {
      const gathered = gatherInput(incoming, outputs, skipped);
      input = gathered.items;
      inputSplit = gathered.firstInputCount;

      if (!gathered.anyBranchActive && incoming.length > 0) {
        // Every upstream branch feeding this node was skipped, so this one is
        // on a path that was not taken. Skipping is correct; running with an
        // empty input would fire side effects on a branch the If rejected.
        skipped.add(node.id);
        await ctx.emit(makeSkipEvent(node, sequence++, 'upstream branch was not taken'));
        continue;
      }
    }

    const paramIssues = validateParams(node.id, definition, node.params);
    if (paramIssues.length > 0) {
      const message = paramIssues.map((issue) => issue.message).join(' ');
      const failure = toFailure(node, { errorType: 'ConfigurationError', message });
      await ctx.emit({
        type: 'nodeFinish',
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        attempt: 1,
        sequence: sequence++,
        status: 'failed',
        input,
        error: { errorType: 'ConfigurationError', message },
        durationMs: 0,
        finishedAt: new Date(),
      });
      if (!node.continueOnFail) {
        return { status: 'failed', failure, outputs, durationMs: Date.now() - startedAt };
      }
      outputs[node.id] = errorOutput(definition, node, { errorType: 'ConfigurationError', message });
      continue;
    }

    const attempt = await runNodeWithRetries({
      ctx,
      node,
      definition,
      input,
      inputSplit,
      outputs,
      now,
      nextSequence: () => sequence++,
    });

    if (attempt.ok) {
      outputs[node.id] = attempt.output;
      continue;
    }

    if (ctx.signal.aborted) {
      return { status: 'cancelled', outputs, durationMs: Date.now() - startedAt };
    }

    if (node.continueOnFail) {
      outputs[node.id] = errorOutput(definition, node, attempt.error);
      continue;
    }

    return {
      status: 'failed',
      failure: toFailure(node, attempt.error),
      outputs,
      durationMs: Date.now() - startedAt,
    };
  }

  return { status: 'success', outputs, durationMs: Date.now() - startedAt };
}

// ---------------------------------------------------------------------------
// Node execution
// ---------------------------------------------------------------------------

interface RunNodeArgs {
  ctx: RunnerContext;
  node: GraphNode;
  definition: NodeDefinition;
  input: Item[];
  inputSplit: number;
  outputs: Record<string, Item[][]>;
  now: string;
  nextSequence(): number;
}

type NodeAttempt =
  | { ok: true; output: Item[][] }
  | { ok: false; error: ExtractedError };

async function runNodeWithRetries(args: RunNodeArgs): Promise<NodeAttempt> {
  const { ctx, node, definition } = args;
  const maxRetries = node.retries ?? definition.defaultRetries ?? 0;
  const backoffMs = node.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;

  let lastError: ExtractedError = { errorType: 'UnknownError', message: 'The node did not run.' };

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (ctx.signal.aborted) return { ok: false, error: { errorType: 'CancelledError', message: 'Cancelled.' } };

    const sequence = args.nextSequence();
    const startedAt = new Date();

    await ctx.emit({
      type: 'nodeStart',
      nodeId: node.id,
      nodeName: node.name,
      nodeType: node.type,
      attempt,
      sequence,
      input: args.input,
      startedAt,
    });

    try {
      const raw = await definition.execute(buildContext(args));
      const output = normaliseOutput(raw, resolveOutputs(definition, node.params));

      await ctx.emit({
        type: 'nodeFinish',
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        attempt,
        sequence,
        status: 'success',
        input: args.input,
        output: output.flat(),
        durationMs: Date.now() - startedAt.getTime(),
        finishedAt: new Date(),
      });

      return { ok: true, output };
    } catch (error) {
      lastError = describeError(error);
      const willRetry = attempt <= maxRetries && isRetryable(lastError) && !ctx.signal.aborted;

      await ctx.emit({
        type: 'nodeFinish',
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        attempt,
        sequence,
        status: 'failed',
        input: args.input,
        error: lastError,
        durationMs: Date.now() - startedAt.getTime(),
        finishedAt: new Date(),
        willRetry,
      });

      if (!willRetry) return { ok: false, error: lastError };

      // Exponential backoff. Each attempt is its own NodeRun row, so the
      // detail view shows that the first two tries failed before one worked.
      await delay(backoffMs * 2 ** (attempt - 1), ctx.signal);
    }
  }

  return { ok: false, error: lastError };
}

/**
 * Retrying a misconfigured node just fails three times more slowly. Only
 * failures that could plausibly be transient are worth another attempt.
 */
export function isRetryable(error: ExtractedError): boolean {
  if (error.errorType === 'ConfigurationError') return false;
  if (error.errorType === 'ExpressionError') return false;
  if (error.errorType === 'CancelledError') return false;
  if (error.errorType === 'CodeSyntaxError') return false;
  // 4xx means the request was wrong, not unlucky. 429 is the exception.
  const http = error.errorType.match(/^HttpError(\d{3})$/);
  if (http) {
    const status = Number(http[1]);
    return status === 408 || status === 429 || status >= 500;
  }
  // Telegram answers with HTTP status codes too, so the same rule applies: a
  // wrong chat id is a 400 and retrying it three times helps nobody.
  const telegram = error.errorType.match(/^TelegramError(\d{3})$/);
  if (telegram) {
    const status = Number(telegram[1]);
    return status === 408 || status === 429 || status >= 500;
  }
  return true;
}

function buildContext(args: RunNodeArgs): NodeExecuteContext {
  const { ctx, node, definition, input } = args;
  const scopeCache = new Map<number, ExpressionScope>();

  const nodeOutputsByName = buildNodeOutputScope(ctx.graph, args.outputs);

  const scopeFor = (itemIndex: number): ExpressionScope => {
    const cached = scopeCache.get(itemIndex);
    if (cached) return cached;
    const scope: ExpressionScope = {
      $json: input[itemIndex]?.json ?? {},
      $items: input,
      $index: itemIndex,
      $node: nodeOutputsByName,
      $now: args.now,
      $env: exposedEnv(),
      $execution: { id: ctx.executionId, workflowId: ctx.workflowId, mode: ctx.mode },
    };
    scopeCache.set(itemIndex, scope);
    return scope;
  };

  const schemas = new Map(definition.params.map((schema) => [schema.name, schema]));

  return {
    items: input,
    node: { id: node.id, name: node.name, type: node.type },
    executionId: ctx.executionId,
    signal: ctx.signal,

    getParam<T>(name: string, itemIndex = 0): T {
      if (name === INTERNAL_INPUT_SPLIT) return args.inputSplit as T;
      if (name === INTERNAL_NODE_OUTPUTS) return nodeOutputsByName as T;

      const schema = schemas.get(name);
      const raw = node.params[name];

      if (raw === undefined) return (schema?.default as T) ?? (undefined as T);
      if (schema && !isParamVisible(schema, node.params)) return undefined as T;
      if (schema && !paramUsesExpressions(schema)) return raw as T;

      try {
        return resolveValue(raw, scopeFor(itemIndex)) as T;
      } catch (error) {
        // Name the parameter. "Unknown variable $jsonn" is far less useful than
        // knowing it is the URL field that has the typo.
        const described = describeError(error);
        throw new NodeError(
          'ExpressionError',
          `${schema?.displayName ?? name}: ${described.message}`,
          { param: name, itemIndex },
        );
      }
    },

    async getCredential(paramName: string) {
      const id = node.params[paramName];
      if (typeof id !== 'string' || id === '') return null;
      return ctx.loadCredential(id);
    },

    logger: {
      debug: (message, meta) => emitLog(ctx, node.id, 'debug', message, meta),
      info: (message, meta) => emitLog(ctx, node.id, 'info', message, meta),
      warn: (message, meta) => emitLog(ctx, node.id, 'warn', message, meta),
      error: (message, meta) => emitLog(ctx, node.id, 'error', message, meta),
    },
  };
}

function emitLog(
  ctx: RunnerContext,
  nodeId: string,
  level: LogEvent['level'],
  message: string,
  meta?: unknown,
): void {
  void ctx.emit({
    type: 'log',
    nodeId,
    level,
    message: meta === undefined ? message : `${message} ${safeJson(meta)}`,
    at: new Date(),
  });
}

// ---------------------------------------------------------------------------
// Input and output plumbing
// ---------------------------------------------------------------------------

interface GatheredInput {
  items: Item[];
  /** Where input 1 ends and input 2 begins, for two-input nodes like Merge. */
  firstInputCount: number;
  /** False when every upstream branch was skipped. */
  anyBranchActive: boolean;
}

function gatherInput(
  incoming: Array<{ source: string; sourceOutput: number; targetInput: number }>,
  outputs: Record<string, Item[][]>,
  skipped: Set<string>,
): GatheredInput {
  const byInput = new Map<number, Item[]>();
  let anyBranchActive = false;

  // Stable order so a node fed by several edges sees the same sequence twice.
  const sorted = [...incoming].sort(
    (a, b) => a.targetInput - b.targetInput || a.sourceOutput - b.sourceOutput,
  );

  for (const edge of sorted) {
    if (skipped.has(edge.source)) continue;
    const sourceOutput = outputs[edge.source];
    if (!sourceOutput) continue;

    anyBranchActive = true;
    const branch = sourceOutput[edge.sourceOutput] ?? [];
    const bucket = byInput.get(edge.targetInput);
    if (bucket) bucket.push(...branch);
    else byInput.set(edge.targetInput, [...branch]);
  }

  const first = byInput.get(0) ?? [];
  const rest = [...byInput.entries()]
    .filter(([key]) => key !== 0)
    .sort((a, b) => a[0] - b[0])
    .flatMap(([, items]) => items);

  return { items: [...first, ...rest], firstInputCount: first.length, anyBranchActive };
}

/** Pad or trim what a node returned so it always matches its declared outputs. */
function normaliseOutput(raw: NodeOutput, outputs: string[]): Item[][] {
  const branches: Item[][] = [];
  for (let i = 0; i < outputs.length; i++) {
    branches.push(raw[i] ?? []);
  }
  return branches;
}

function errorOutput(definition: NodeDefinition, node: GraphNode, error: ExtractedError): Item[][] {
  const branches: Item[][] = resolveOutputs(definition, node.params).map(() => []);
  // continueOnFail still has to produce something, otherwise downstream nodes
  // cannot react to the failure. The error lands on the first branch.
  branches[0] = [{ json: { error: { type: error.errorType, message: error.message } } }];
  return branches;
}

function buildNodeOutputScope(
  graph: Graph,
  outputs: Record<string, Item[][]>,
): Record<string, { json: Record<string, unknown>; items: unknown[] }> {
  const scope: Record<string, { json: Record<string, unknown>; items: unknown[] }> = {};

  for (const node of graph.nodes) {
    const output = outputs[node.id];
    if (!output) continue;
    const items = output.flat();
    scope[node.name] = { json: items[0]?.json ?? {}, items };
  }

  return scope;
}

function isRunEntryPoint(node: GraphNode, ctx: RunnerContext, order: GraphNode[]): boolean {
  // A manual run starts at the first trigger in canvas order. A webhook or
  // schedule run names its trigger explicitly via startNodeId, so this is only
  // reached for manual runs and single-trigger workflows.
  const firstTrigger = order.find((candidate) => {
    const definition = requireNodeDefinition(candidate.type);
    return definition.inputs === 0 && !candidate.disabled;
  });
  return firstTrigger?.id === node.id;
}

function makeSkipEvent(node: GraphNode, sequence: number, reason: string): NodeFinishEvent {
  const at = new Date();
  return {
    type: 'nodeFinish',
    nodeId: node.id,
    nodeName: node.name,
    nodeType: node.type,
    attempt: 1,
    sequence,
    status: 'skipped',
    input: [],
    output: [],
    error: { errorType: 'Skipped', message: reason },
    durationMs: 0,
    finishedAt: at,
  };
}

function toFailure(node: GraphNode, error: ExtractedError): RunFailure {
  return {
    nodeId: node.id,
    nodeName: node.name,
    nodeType: node.type,
    errorType: error.errorType,
    message: error.message,
    fingerprint: errorFingerprint({
      nodeType: node.type,
      errorType: error.errorType,
      message: error.message,
    }),
  };
}

function exposedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('M8X_VAR_') && value !== undefined) out[key.slice('M8X_VAR_'.length)] = value;
  }
  return out;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
  });
}
