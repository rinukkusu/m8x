import type { Graph, GraphEdge, GraphNode } from './types.js';

export interface GraphIndex {
  byId: Map<string, GraphNode>;
  byName: Map<string, GraphNode>;
  /** Edges leaving each node. */
  outgoing: Map<string, GraphEdge[]>;
  /** Edges arriving at each node. */
  incoming: Map<string, GraphEdge[]>;
}

export function indexGraph(graph: Graph): GraphIndex {
  const byId = new Map<string, GraphNode>();
  const byName = new Map<string, GraphNode>();
  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();

  for (const node of graph.nodes) {
    byId.set(node.id, node);
    byName.set(node.name, node);
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  }

  for (const edge of graph.edges) {
    // Edges pointing at nodes that were deleted are ignored rather than fatal,
    // so a half-cleaned graph still runs.
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    outgoing.get(edge.source)!.push(edge);
    incoming.get(edge.target)!.push(edge);
  }

  return { byId, byName, outgoing, incoming };
}

/**
 * The one node type allowed to close a cycle.
 *
 * A string rather than an import from the node registry: the editor calls
 * `validateGraph` in the browser, and this file deliberately imports nothing but
 * types so it can.
 */
export const LOOP_NODE_TYPE = 'flow.loopOverItems';

/** Output branch indexes on a loop node, matching its descriptor. */
const LOOP_BRANCH = 0;
const DONE_BRANCH = 1;

export interface ValidationIssue {
  level: 'error' | 'warning';
  nodeId?: string;
  message: string;
}

/**
 * Structural checks that do not need the node registry. The runner refuses to
 * start when any issue is at 'error' level.
 */
export function validateGraph(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const index = indexGraph(graph);

  if (graph.nodes.length === 0) {
    issues.push({ level: 'error', message: 'The workflow has no nodes.' });
    return issues;
  }

  const seenNames = new Set<string>();
  for (const node of graph.nodes) {
    if (seenNames.has(node.name)) {
      // Expressions address nodes by name, so duplicates would be ambiguous.
      issues.push({
        level: 'error',
        nodeId: node.id,
        message: `More than one node is named "${node.name}".`,
      });
    }
    seenNames.add(node.name);
  }

  const loops = analyseLoops(graph);
  issues.push(...loops.issues);

  const cycle = findCycle(withoutBackEdges(graph, loops));
  if (cycle) {
    const names = cycle.map((id) => index.byId.get(id)?.name ?? id).join(' -> ');
    const throughLoop = cycle.some((id) => index.byId.get(id)?.type === LOOP_NODE_TYPE);
    issues.push({
      level: 'error',
      nodeId: cycle[0],
      message: throughLoop
        ? `The workflow loops back on itself: ${names}. Only a Loop Over Items node's Loop branch may start a loop.`
        : `The workflow loops back on itself: ${names}. Only a Loop Over Items node can close a loop.`,
    });
  }

  for (const node of graph.nodes) {
    if (node.disabled) continue;
    const hasInput = (index.incoming.get(node.id) ?? []).length > 0;
    const hasOutput = (index.outgoing.get(node.id) ?? []).length > 0;
    if (!hasInput && !hasOutput && graph.nodes.length > 1) {
      issues.push({
        level: 'warning',
        nodeId: node.id,
        message: `"${node.name}" is not connected to anything and will not run.`,
      });
    }
  }

  return issues;
}

export interface LoopAnalysis {
  /** Ids of the edges that legally close a loop. */
  backEdges: Set<string>;
  /** Loop node id -> the nodes that re-run on every iteration. */
  regions: Map<string, Set<string>>;
  issues: ValidationIssue[];
}

/**
 * Work out which cycles are a loop and which are a mistake.
 *
 * A loop node's region is everything reachable from its Loop branch that is not
 * also reachable from its Done branch. The subtraction is doing real work: a
 * node fed by both branches is where the loop rejoins the rest of the workflow
 * and must run once, afterwards, while a leaf hanging off the Loop branch that
 * never returns (a "notify per batch" node) is inside and re-runs every
 * iteration, which is what putting it there means.
 */
export function analyseLoops(graph: Graph): LoopAnalysis {
  const index = indexGraph(graph);
  const backEdges = new Set<string>();
  const regions = new Map<string, Set<string>>();
  const issues: ValidationIssue[] = [];
  const name = (id: string) => index.byId.get(id)?.name ?? id;

  const loopNodes = graph.nodes.filter((node) => node.type === LOOP_NODE_TYPE);
  const doneReach = new Map<string, Set<string>>();

  for (const loop of loopNodes) {
    const outgoing = index.outgoing.get(loop.id) ?? [];
    const targetsOn = (branch: number) =>
      outgoing.filter((edge) => edge.sourceOutput === branch).map((edge) => edge.target);

    const fromLoop = reachableFrom(index, targetsOn(LOOP_BRANCH), loop.id);
    const fromDone = reachableFrom(index, targetsOn(DONE_BRANCH), loop.id);

    const region = new Set<string>();
    for (const id of fromLoop) if (!fromDone.has(id)) region.add(id);
    regions.set(loop.id, region);
    doneReach.set(loop.id, fromDone);
  }

  // Nesting is settled first. In a genuinely nested pair the outer loop always
  // sits on the inner one's Done path — that is what nesting looks like from the
  // inside — so checking the Done rule first would report the wrong problem.
  const nested = new Set<string>();
  for (const outer of loopNodes) {
    for (const inner of loopNodes) {
      if (inner.id === outer.id || !regions.get(outer.id)!.has(inner.id)) continue;
      nested.add(outer.id);
      nested.add(inner.id);
      issues.push({
        level: 'error',
        nodeId: inner.id,
        message: `"${inner.name}" sits inside the loop of "${outer.name}". Loops inside loops are not supported yet.`,
      });
    }
  }

  for (const loop of loopNodes) {
    const region = regions.get(loop.id)!;

    for (const edge of index.incoming.get(loop.id) ?? []) {
      if (region.has(edge.source)) {
        backEdges.add(edge.id);
        continue;
      }
      if (nested.has(loop.id) || !doneReach.get(loop.id)!.has(edge.source)) continue;
      issues.push({
        level: 'error',
        nodeId: edge.source,
        message: `"${name(edge.source)}" is on the Done branch of "${loop.name}" and leads back into it. Only the Loop branch may return.`,
      });
    }
  }

  for (const loop of loopNodes) {
    if (nested.has(loop.id)) continue;
    const returns = (index.incoming.get(loop.id) ?? []).some((edge) => backEdges.has(edge.id));
    if (returns) continue;
    issues.push({
      level: 'warning',
      nodeId: loop.id,
      message: `Nothing returns to "${loop.name}", so its Done output will be empty. Connect the end of the loop back to it.`,
    });
  }

  return { backEdges, regions, issues };
}

/** The graph with the back-edges removed, which makes it a DAG again. */
export function withoutBackEdges(graph: Graph, analysis: LoopAnalysis): Graph {
  if (analysis.backEdges.size === 0) return graph;
  return { nodes: graph.nodes, edges: graph.edges.filter((edge) => !analysis.backEdges.has(edge.id)) };
}

/**
 * Collapse each loop region onto its loop node.
 *
 * The outer pass orders this, then steps over each loop node once and runs its
 * region itself. Collapsing rather than ordering the whole graph and skipping
 * region members matters: a node outside the loop feeding one inside it has to
 * be ordered before the loop node, or the region would gather nothing on the
 * first iteration and be skipped as a branch that was not taken.
 */
export function condenseLoops(graph: Graph, analysis: LoopAnalysis): Graph {
  if (analysis.regions.size === 0) return graph;

  const owner = new Map<string, string>();
  for (const [loopId, region] of analysis.regions) {
    for (const id of region) owner.set(id, loopId);
  }

  const nodes = graph.nodes.filter((node) => !owner.has(node.id));
  const edges: GraphEdge[] = [];

  for (const edge of graph.edges) {
    if (analysis.backEdges.has(edge.id)) continue;
    const source = owner.get(edge.source) ?? edge.source;
    const target = owner.get(edge.target) ?? edge.target;
    if (source === target) continue;
    edges.push({ ...edge, source, target });
  }

  return { nodes, edges };
}

/** The part of the graph made of `ids`, keeping only the edges between them. */
export function subgraphOf(graph: Graph, ids: Set<string>): Graph {
  return {
    nodes: graph.nodes.filter((node) => ids.has(node.id)),
    edges: graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
  };
}

/** Everything reachable from `starts`, never passing through `stopAt`. */
function reachableFrom(index: GraphIndex, starts: string[], stopAt: string): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];

  for (const id of starts) {
    if (id === stopAt || seen.has(id)) continue;
    seen.add(id);
    queue.push(id);
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const edge of index.outgoing.get(id) ?? []) {
      if (edge.target === stopAt || seen.has(edge.target)) continue;
      seen.add(edge.target);
      queue.push(edge.target);
    }
  }

  return seen;
}

/** Returns the node ids forming a cycle, or null when the graph is acyclic. */
export function findCycle(graph: Graph): string[] | null {
  const index = indexGraph(graph);
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  function visit(nodeId: string): string[] | null {
    const current = state.get(nodeId);
    if (current === 'done') return null;
    if (current === 'visiting') {
      return stack.slice(stack.indexOf(nodeId)).concat(nodeId);
    }

    state.set(nodeId, 'visiting');
    stack.push(nodeId);

    for (const edge of index.outgoing.get(nodeId) ?? []) {
      const found = visit(edge.target);
      if (found) return found;
    }

    stack.pop();
    state.set(nodeId, 'done');
    return null;
  }

  for (const node of graph.nodes) {
    const found = visit(node.id);
    if (found) return found;
  }
  return null;
}

/**
 * Kahn's algorithm, with ties broken by the node's position on the canvas so
 * that independent branches run in the order the author laid them out. Without
 * that, execution order would shuffle between runs and the detail view would be
 * confusing to read.
 */
export function topologicalOrder(graph: Graph): GraphNode[] {
  const index = indexGraph(graph);
  const indegree = new Map<string, number>();

  for (const node of graph.nodes) {
    indegree.set(node.id, (index.incoming.get(node.id) ?? []).length);
  }

  const ready = graph.nodes.filter((node) => indegree.get(node.id) === 0);
  ready.sort(byCanvasPosition);

  const order: GraphNode[] = [];

  while (ready.length > 0) {
    const node = ready.shift()!;
    order.push(node);

    const unlocked: GraphNode[] = [];
    for (const edge of index.outgoing.get(node.id) ?? []) {
      const remaining = (indegree.get(edge.target) ?? 0) - 1;
      indegree.set(edge.target, remaining);
      if (remaining === 0) {
        const target = index.byId.get(edge.target);
        if (target) unlocked.push(target);
      }
    }

    unlocked.sort(byCanvasPosition);
    ready.unshift(...unlocked);
  }

  if (order.length !== graph.nodes.length) {
    throw new Error('The workflow contains a cycle and cannot be ordered.');
  }

  return order;
}

function byCanvasPosition(a: GraphNode, b: GraphNode): number {
  if (a.position.y !== b.position.y) return a.position.y - b.position.y;
  return a.position.x - b.position.x;
}

/** Nodes with no incoming edges. These are where an execution starts. */
export function findEntryNodes(graph: Graph): GraphNode[] {
  const index = indexGraph(graph);
  return graph.nodes.filter((node) => (index.incoming.get(node.id) ?? []).length === 0);
}

/** Every node reachable from `startId`, including it. */
export function descendantsOf(graph: Graph, startId: string): Set<string> {
  const index = indexGraph(graph);
  const seen = new Set<string>([startId]);
  const queue = [startId];

  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const edge of index.outgoing.get(id) ?? []) {
      if (seen.has(edge.target)) continue;
      seen.add(edge.target);
      queue.push(edge.target);
    }
  }

  return seen;
}
