/**
 * The data unit that flows between nodes.
 *
 * Every node receives an array of items and emits an array of items. Keeping
 * this shape uniform is what makes fan-out, filtering and merging fall out of
 * the model instead of needing special cases per node.
 */
export interface Item {
  json: Record<string, unknown>;
  binary?: Record<string, BinaryData>;
}

export interface BinaryData {
  mimeType: string;
  fileName?: string;
  /** base64 */
  data: string;
}

/** One array of items per output branch. Index 0 is the first branch. */
export type NodeOutput = Item[][];

// ---------------------------------------------------------------------------
// Parameter schema
//
// Nodes declare their parameters; the editor renders the whole inspector panel
// from this. Hand-writing a form per node is the thing that makes adding a node
// expensive, so nothing is allowed to bypass it.
// ---------------------------------------------------------------------------

export type ParamType =
  | 'string'
  | 'text'
  | 'number'
  | 'boolean'
  | 'select'
  | 'json'
  | 'code'
  | 'keyValue';

export interface ParamOption {
  label: string;
  value: string;
}

export interface ParamSchema {
  name: string;
  displayName: string;
  type: ParamType;
  default?: unknown;
  required?: boolean;
  description?: string;
  placeholder?: string;
  /** For type 'select'. */
  options?: ParamOption[];
  /**
   * Show this parameter only when the named sibling parameters hold one of the
   * listed values, e.g. `{ method: ['POST', 'PUT'] }`.
   */
  showIf?: Record<string, unknown[]>;
  /**
   * Whether `{{ ... }}` templates are resolved in this value.
   * Defaults to true for string, text and number; false otherwise.
   */
  expression?: boolean;
  /** Name of a credential type this parameter selects. */
  credentialType?: string;
  /** Column placeholders for type 'keyValue'. Default to "name" and "value". */
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

export type NodeGroup = 'trigger' | 'action' | 'flow';

// ---------------------------------------------------------------------------
// Execution context
// ---------------------------------------------------------------------------

export interface NodeLogger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export interface NodeExecuteContext {
  /** Items arriving on the node's input. */
  readonly items: Item[];

  /**
   * Resolve a parameter, running any `{{ }}` expression against the given item.
   * Expressions can differ per item, so nodes that act per item must pass the
   * item index rather than reading the parameter once.
   */
  getParam<T = unknown>(name: string, itemIndex?: number): T;

  /** Decrypted credential data, or null when none is selected. */
  getCredential(paramName: string): Promise<Record<string, string> | null>;

  /**
   * Run another workflow and return the items it ended with.
   *
   * Throws a NodeError when the child fails, so continueOnFail and the failures
   * page treat it like any other node going wrong. With `wait: false` the child
   * is queued and a single item naming its execution comes back instead.
   */
  executeWorkflow(
    workflowId: string,
    items: Item[],
    options?: { wait?: boolean },
  ): Promise<Item[]>;

  readonly node: { id: string; name: string; type: string };
  readonly executionId: string;
  readonly logger: NodeLogger;
  /** Aborted when the execution is cancelled or times out. */
  readonly signal: AbortSignal;
}

/**
 * Everything about a node except how it runs.
 *
 * This half is deliberately free of behaviour and of any Node.js import, so the
 * editor can render the palette and generate every inspector panel without
 * pulling the execution code, and the Code node's child-process sandbox, into
 * the browser bundle.
 */
export interface NodeDescriptor {
  /** Stable identifier persisted in the graph. Never rename one of these. */
  type: string;
  displayName: string;
  description: string;
  group: NodeGroup;
  /** Lucide icon name, rendered by the canvas. */
  icon: string;
  /** Hex used for the node accent on the canvas. */
  color: string;
  /** 0 for triggers, otherwise 1. Merge is the exception at 2. */
  inputs: number;
  /** Labels for each output branch. A plain node has one unnamed branch. */
  outputs: string[];
  /**
   * Name of a `keyValue` parameter whose rows define the output branches, for a
   * node like Switch whose branch count is up to its author. `outputs` is then
   * the fallback for a node that has not been configured yet. Read it through
   * `resolveOutputs`, never directly.
   */
  outputsFrom?: string;
  params: ParamSchema[];
  /** Default retry policy, overridable per node instance. */
  defaultRetries?: number;
}

export type NodeExecute = (ctx: NodeExecuteContext) => Promise<NodeOutput>;

/** A descriptor plus its behaviour. Only the runner ever holds one of these. */
export interface NodeDefinition extends NodeDescriptor {
  execute: NodeExecute;
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  type: string;
  name: string;
  position: { x: number; y: number };
  params: Record<string, unknown>;
  disabled?: boolean;
  /** Let the execution carry on past a throw in this node. */
  continueOnFail?: boolean;
  /** Attempts after the first. 0 means no retry. */
  retries?: number;
  /** Milliseconds between retries, doubled each attempt. */
  retryBackoffMs?: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  /** Index into the source node's `outputs`. */
  sourceOutput: number;
  target: string;
  /** Index into the target node's inputs. */
  targetInput: number;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const EMPTY_GRAPH: Graph = { nodes: [], edges: [] };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown by nodes to attach a stable machine-readable type to a failure. */
export class NodeError extends Error {
  readonly errorType: string;
  readonly details: Record<string, unknown>;

  constructor(errorType: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'NodeError';
    this.errorType = errorType;
    this.details = details;
  }
}
