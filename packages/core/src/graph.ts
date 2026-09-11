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

  const cycle = findCycle(graph);
  if (cycle) {
    issues.push({
      level: 'error',
      nodeId: cycle[0],
      message: `The workflow loops back on itself: ${cycle
        .map((id) => index.byId.get(id)?.name ?? id)
        .join(' -> ')}. Loops are not supported yet.`,
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
