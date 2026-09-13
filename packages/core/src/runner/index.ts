import { delay } from '../delay.js';
import { resolveValue, type ExpressionScope } from '../expressions.js';
import { describeError, errorFingerprint, type ExtractedError } from '../fingerprint.js';
import {
  analyseLoops,
  condenseLoops,
  indexGraph,
  subgraphOf,
  topologicalOrder,
  validateGraph,
  withoutBackEdges,
} from '../graph.js';
import { requireNodeDefinition } from '../nodes/executors.js';
import { isParamVisible, paramUsesExpressions, resolveOutputs, validateParams } from '../nodes/index.js';
import {
  NodeError,
  type BinaryData,
  type Graph,
  type GraphEdge,
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
  /** Which pass of a loop produced this. 0 for a node outside any loop. */
  iteration: number;
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
  /** Which pass of a loop produced this. 0 for a node outside any loop. */
  iteration: number;
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

/** What a node asks for when it runs another workflow. */
export interface SubWorkflowRequest {
  workflowId: string;
  items: Item[];
  /** The node that asked, for the child execution row and the link back. */
  nodeId: string;
  /** How many levels of nesting are still allowed below this one. */
  depth: number;
  /** Workflows already running further up the chain, innermost last. */
  stack: readonly string[];
  /** False queues the child and returns without waiting for it. */
  wait: boolean;
  signal: AbortSignal;
}

export interface SubWorkflowResult {
  executionId: string;
  status: 'success' | 'failed' | 'cancelled' | 'queued';
  items: Item[];
  workflowName?: string;
  failure?: RunFailure;
}

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
  /**
   * The binary store, injected for the same reason. Absent in a bare runner,
   * where a node asking for bytes gets a clear failure rather than a crash.
   */
  readBinary?(binary: BinaryData): Promise<Uint8Array>;
  writeBinary?(input: { bytes: Uint8Array; mimeType: string; fileName?: string }): Promise<BinaryData>;
  /**
   * Run another workflow. Injected for the same reason as loadCredential: the
   * child needs an execution row, and core does not touch the database.
   * Absent when the embedder does not support it, which the node reports.
   */
  runWorkflowById?(request: SubWorkflowRequest): Promise<SubWorkflowResult>;
  /** Levels of nesting still allowed below this run. */
  subWorkflowDepth?: number;
  /** Workflows already running above this one, innermost last. */
  subWorkflowStack?: readonly string[];
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
const INTERNAL_LOOP_CURSOR = '__loopCursor';
const INTERNAL_LOOP_DONE = '__loopDone';

/**
 * A loop that never empties its batch would otherwise spin until the execution
 * timeout an hour later, with nothing in the detail view to say why.
 */
const MAX_LOOP_ITERATIONS = Number(process.env.M8X_MAX_LOOP_ITERATIONS ?? 1000);

/** How deep one workflow may call another. */
export const MAX_SUBWORKFLOW_DEPTH = Number(process.env.M8X_MAX_SUBWORKFLOW_DEPTH ?? 5);

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

  const loops = analyseLoops(ctx.graph);
  // The runner works on the graph with back-edges removed, which is a DAG
  // again, and steps over each loop region as a single node in the outer order.
  const reduced = withoutBackEdges(ctx.graph, loops);
  const index = indexGraph(reduced);
  const order = topologicalOrder(condenseLoops(reduced, loops));
  const outputs: Record<string, Item[][]> = { ...(ctx.restoredOutputs ?? {}) };
  /** Nodes that did not run, so downstream nodes know the branch was not taken. */
  const skipped = new Set<string>();
  const now = new Date().toISOString();

  const backEdgesInto = new Map<string, GraphEdge[]>();
  for (const edge of ctx.graph.edges) {
    if (!loops.backEdges.has(edge.id)) continue;
    const bucket = backEdgesInto.get(edge.target);
    if (bucket) bucket.push(edge);
    else backEdgesInto.set(edge.target, [edge]);
  }

  let sequence = 0;
  // A retry point inside a loop has no meaning the outer order can express, so
  // one that is not in it re-runs everything rather than silently running
  // nothing at all.
  let startReached = ctx.startNodeId === undefined || !order.some((node) => node.id === ctx.startNodeId);

  async function step(node: GraphNode, options: StepOptions = {}): Promise<Step> {
    const definition = requireNodeDefinition(node.type);
    const incoming = index.incoming.get(node.id) ?? [];
    const iteration = options.iteration ?? 0;

    if (node.disabled) {
      // A disabled node is a pass-through, not a wall. Turning one off to test
      // around it should not sever the rest of the workflow.
      const gathered = gatherInput(incoming, outputs, skipped);

      // Unless there was nothing to pass through: a disabled node sitting on a
      // branch the If rejected must stay skipped, or it would hand the rest of
      // that branch an empty input and let it fire its side effects.
      if (!gathered.anyBranchActive && incoming.length > 0) {
        skipped.add(node.id);
        await ctx.emit(makeSkipEvent(node, sequence++, 'upstream branch was not taken', iteration));
        return OK;
      }

      outputs[node.id] = [gathered.items];
      await ctx.emit(makeSkipEvent(node, sequence++, 'disabled', iteration));
      return OK;
    }

    let input: Item[];
    let inputSplit = 0;

    if (options.input !== undefined) {
      // A loop node on its second and later iterations, where the items come
      // from the cursor rather than from the incoming edges.
      input = options.input;
    } else if (definition.inputs === 0) {
      // Trigger. Only the one the run actually started from produces items.
      const isEntryPoint = ctx.startNodeId ? node.id === ctx.startNodeId : isRunEntryPoint(node, ctx, order);
      if (!isEntryPoint) {
        skipped.add(node.id);
        await ctx.emit(makeSkipEvent(node, sequence++, 'not the trigger for this run', iteration));
        return OK;
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
        await ctx.emit(makeSkipEvent(node, sequence++, 'upstream branch was not taken', iteration));
        return OK;
      }
    }

    const continueOnFail = node.continueOnFail === true && options.ignoreContinueOnFail !== true;

    const paramIssues = validateParams(node.id, definition, node.params);
    if (paramIssues.length > 0) {
      const message = paramIssues.map((issue) => issue.message).join(' ');
      const error: ExtractedError = { errorType: 'ConfigurationError', message };
      await ctx.emit({
        type: 'nodeFinish',
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        attempt: 1,
        iteration,
        sequence: sequence++,
        status: 'failed',
        input,
        error,
        durationMs: 0,
        finishedAt: new Date(),
      });
      if (!continueOnFail) return { kind: 'failed', failure: toFailure(node, error) };
      outputs[node.id] = errorOutput(definition, node, error);
      return OK;
    }

    const attempt = await runNodeWithRetries({
      ctx,
      node,
      definition,
      input,
      inputSplit,
      loop: options.loop,
      iteration,
      outputs,
      now,
      nextSequence: () => sequence++,
    });

    if (attempt.ok) {
      outputs[node.id] = attempt.output;
      return OK;
    }

    if (ctx.signal.aborted) return CANCELLED;
    if (continueOnFail) {
      outputs[node.id] = errorOutput(definition, node, attempt.error);
      return OK;
    }

    return { kind: 'failed', failure: toFailure(node, attempt.error) };
  }

  async function runLoop(loop: GraphNode): Promise<Step> {
    const region = loops.regions.get(loop.id) ?? new Set<string>();
    const incoming = index.incoming.get(loop.id) ?? [];
    const entry = gatherInput(incoming, outputs, skipped);

    if (!entry.anyBranchActive && incoming.length > 0) {
      // The whole region goes with it, or the nodes inside would look like they
      // simply produced nothing rather than never having been reached.
      skipped.add(loop.id);
      await ctx.emit(makeSkipEvent(loop, sequence++, 'upstream branch was not taken', 0));
      for (const id of region) {
        const member = index.byId.get(id);
        if (!member) continue;
        skipped.add(id);
        await ctx.emit(makeSkipEvent(member, sequence++, 'upstream branch was not taken', 0));
      }
      return OK;
    }

    const bodyOrder = topologicalOrder(subgraphOf(reduced, new Set([loop.id, ...region]))).filter(
      (node) => node.id !== loop.id,
    );

    const state: LoopState = { cursor: 0, done: [] };

    for (let iteration = 1; ; iteration++) {
      if (ctx.signal.aborted) return CANCELLED;

      if (iteration > MAX_LOOP_ITERATIONS) return await failLoop(loop, iteration);

      // continueOnFail is refused on the loop node itself: carrying on past a
      // batching failure would iterate on an error item, which is never what
      // anyone means by it.
      const result = await step(loop, {
        input: entry.items,
        loop: state,
        iteration,
        ignoreContinueOnFail: true,
      });
      if (result.kind !== 'ok') return result;

      const batch = outputs[loop.id]?.[0] ?? [];
      if (batch.length === 0) break;
      state.cursor += batch.length;

      // Start each pass with the region blank. Everything inside traces back to
      // the loop node, which always runs, so nothing in here is skipped today —
      // but leaving one pass's output and skip marks lying around for the next
      // one is the kind of state that goes wrong the moment a node type with
      // different input rules joins the group.
      for (const id of region) {
        delete outputs[id];
        skipped.delete(id);
      }

      for (const node of bodyOrder) {
        if (ctx.signal.aborted) return CANCELLED;
        const bodyResult = await step(node, { iteration });
        if (bodyResult.kind !== 'ok') return bodyResult;
      }

      const back = gatherInput(backEdgesInto.get(loop.id) ?? [], outputs, skipped);
      if (back.anyBranchActive) state.done.push(...back.items);
    }

    return OK;
  }

  async function failLoop(loop: GraphNode, iteration: number): Promise<Step> {
    const error: ExtractedError = {
      errorType: 'LoopLimitError',
      message: `"${loop.name}" ran ${MAX_LOOP_ITERATIONS} times without finishing. Raise M8X_MAX_LOOP_ITERATIONS if that is expected.`,
    };
    await ctx.emit({
      type: 'nodeFinish',
      nodeId: loop.id,
      nodeName: loop.name,
      nodeType: loop.type,
      attempt: 1,
      iteration,
      sequence: sequence++,
      status: 'failed',
      input: [],
      error,
      durationMs: 0,
      finishedAt: new Date(),
    });
    return { kind: 'failed', failure: toFailure(loop, error) };
  }

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

    const result = loops.regions.has(node.id) ? await runLoop(node) : await step(node);

    if (result.kind === 'cancelled' || ctx.signal.aborted) {
      return { status: 'cancelled', outputs, durationMs: Date.now() - startedAt };
    }
    if (result.kind === 'failed') {
      return { status: 'failed', failure: result.failure, outputs, durationMs: Date.now() - startedAt };
    }
  }

  return { status: 'success', outputs, durationMs: Date.now() - startedAt };
}

/** How a single node's turn ended, as far as the run is concerned. */
type Step = { kind: 'ok' } | { kind: 'cancelled' } | { kind: 'failed'; failure: RunFailure };

const OK: Step = { kind: 'ok' };
const CANCELLED: Step = { kind: 'cancelled' };

interface StepOptions {
  /** Run with these items instead of gathering them from the incoming edges. */
  input?: Item[];
  loop?: LoopState;
  iteration?: number;
  ignoreContinueOnFail?: boolean;
}

/** Where a loop has got to. Held by the runner, never by the node. */
interface LoopState {
  cursor: number;
  done: Item[];
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
  loop?: LoopState;
  /** Which pass of a loop this is. 0 outside any loop. */
  iteration: number;
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
      iteration: args.iteration,
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
        iteration: args.iteration,
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
        iteration: args.iteration,
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
  // A runaway loop is structural. Running it again just burns another 1000
  // iterations.
  if (error.errorType === 'LoopLimitError') return false;
  // The child already retried its own nodes. Running the whole workflow again
  // would repeat every side effect it managed to fire before it failed.
  if (error.errorType === 'SubWorkflowError') return false;
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

/**
 * Refuse a sub-workflow call that would not terminate.
 *
 * Two checks because they catch different things: the stack stops A calling B
 * calling A before anything runs, and the depth budget bounds legitimate
 * fan-out that never repeats a workflow.
 */
export function assertCanCall(stack: readonly string[], depth: number, workflowId: string): void {
  if (stack.includes(workflowId)) {
    throw new NodeError(
      'SubWorkflowError',
      'That workflow is already running further up this chain, so calling it here would not terminate.',
      { workflowId, stack: [...stack] },
    );
  }
  if (depth <= 0) {
    throw new NodeError(
      'SubWorkflowError',
      `Workflows are nested more than ${MAX_SUBWORKFLOW_DEPTH} deep. Raise M8X_MAX_SUBWORKFLOW_DEPTH if that is expected.`,
    );
  }
}

/**
 * What a sub-workflow hands back: the output of every node that ran and has
 * nothing after it.
 */
export function terminalOutputs(graph: Graph, outputs: Record<string, Item[][]>): Item[] {
  // A child workflow may contain a loop, and a back-edge would make ordering
  // throw rather than answer.
  const acyclic = withoutBackEdges(graph, analyseLoops(graph));
  const index = indexGraph(acyclic);
  const items: Item[] = [];

  for (const node of topologicalOrder(acyclic)) {
    if ((index.outgoing.get(node.id) ?? []).length > 0) continue;
    const output = outputs[node.id];
    if (output) items.push(...output.flat());
  }

  return items;
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
      if (name === INTERNAL_LOOP_CURSOR) return (args.loop?.cursor ?? 0) as T;
      if (name === INTERNAL_LOOP_DONE) return (args.loop?.done ?? []) as T;

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

    async executeWorkflow(workflowId: string, items: Item[], options = {}) {
      if (!ctx.runWorkflowById) {
        throw new NodeError('SubWorkflowError', 'Running another workflow is not available here.');
      }

      const stack = [...(ctx.subWorkflowStack ?? []), ctx.workflowId];
      const depth = ctx.subWorkflowDepth ?? MAX_SUBWORKFLOW_DEPTH;
      // Checked before the child row exists, so a circular call costs nothing
      // and fires no side effects.
      assertCanCall(stack, depth, workflowId);

      const wait = options.wait !== false;
      const result = await ctx.runWorkflowById({
        workflowId,
        items,
        nodeId: node.id,
        depth,
        stack,
        wait,
        signal: ctx.signal,
      });

      if (!wait || result.status === 'queued') {
        return [{ json: { executionId: result.executionId, queued: true } }];
      }
      if (result.status === 'cancelled') {
        throw new NodeError('CancelledError', 'The sub-workflow was cancelled.');
      }
      if (result.status === 'failed') {
        const where = result.failure ? ` at "${result.failure.nodeName}"` : '';
        throw new NodeError(
          'SubWorkflowError',
          `"${result.workflowName ?? workflowId}" failed${where}: ${result.failure?.message ?? 'no reason given'}`,
          {
            childExecutionId: result.executionId,
            childNodeId: result.failure?.nodeId,
            childErrorType: result.failure?.errorType,
          },
        );
      }

      return result.items;
    },

    async getCredential(paramName: string) {
      const id = node.params[paramName];
      if (typeof id !== 'string' || id === '') return null;
      return ctx.loadCredential(id);
    },

    async readBinary(binary: BinaryData) {
      if (typeof binary.data === 'string') return Buffer.from(binary.data, 'base64');
      if (!ctx.readBinary) {
        throw new NodeError('BinaryError', 'Stored files are not available here.');
      }
      return ctx.readBinary(binary);
    },

    async writeBinary(input) {
      if (!ctx.writeBinary) {
        throw new NodeError('BinaryError', 'Storing files is not available here.');
      }
      return ctx.writeBinary(input);
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

function makeSkipEvent(
  node: GraphNode,
  sequence: number,
  reason: string,
  iteration: number,
): NodeFinishEvent {
  const at = new Date();
  return {
    type: 'nodeFinish',
    nodeId: node.id,
    nodeName: node.name,
    nodeType: node.type,
    attempt: 1,
    iteration,
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

