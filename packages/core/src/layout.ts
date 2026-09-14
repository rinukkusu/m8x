import { analyseLoops, indexGraph, withoutBackEdges } from './graph.js';
import type { Graph } from './types.js';

/** Node box on the canvas, matching the width the canvas node renders at. */
const NODE_WIDTH = 224;

/** Left-to-right distance between the left edges of two neighbouring columns. */
const COLUMN_STEP = NODE_WIDTH + 96;

/** Vertical distance between two nodes sharing a column. */
const ROW_STEP = 120;

export interface Position {
  x: number;
  y: number;
}

/**
 * Tidy positions for every node, laid out left to right along the edges.
 *
 * A layered layout, which is the shape these graphs already have: a trigger on
 * the left, work flowing right, branches fanning out. Columns come from the
 * longest path to a node, so an edge never points backwards; rows come from the
 * average row of a node's sources, which is the cheap version of crossing
 * reduction and enough for graphs of this size.
 *
 * Back-edges — the wire returning to a Loop Over Items node — are ignored while
 * layering. They are the one edge allowed to point left, and counting them would
 * push the loop node off to the right of its own body.
 *
 * Positions are translated so the result starts where the graph already starts,
 * so tidying a workflow does not also move it somewhere else on the canvas.
 */
export function autoLayout(graph: Graph): Map<string, Position> {
  const placed = new Map<string, Position>();
  if (graph.nodes.length === 0) return placed;

  const dag = withoutBackEdges(graph, analyseLoops(graph));
  const index = indexGraph(dag);

  // Current row order is the tie-breaker throughout: two nodes the edges say
  // nothing about keep the order the user put them in.
  const drawn = new Map(
    [...graph.nodes]
      .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
      .map((node, order) => [node.id, order] as const),
  );

  const column = columns(dag, index, drawn);
  const byColumn = new Map<number, string[]>();
  for (const node of graph.nodes) {
    const at = column.get(node.id) ?? 0;
    byColumn.set(at, [...(byColumn.get(at) ?? []), node.id]);
  }

  // Rows are settled column by column, left to right, so each column can order
  // itself by where its sources ended up in the column before it.
  const row = new Map<string, number>();
  for (const at of [...byColumn.keys()].sort((a, b) => a - b)) {
    const ids = byColumn.get(at)!;
    const ordered = [...ids].sort((a, b) => {
      const byParents = barycentre(a, index, row, drawn) - barycentre(b, index, row, drawn);
      return byParents || drawn.get(a)! - drawn.get(b)!;
    });

    ordered.forEach((id, offset) => {
      row.set(id, offset);
      placed.set(id, {
        x: at * COLUMN_STEP,
        // Centred on the column, so a chain stays on one line and a fan-out
        // spreads evenly either side of what feeds it.
        y: (offset - (ordered.length - 1) / 2) * ROW_STEP,
      });
    });
  }

  const origin = {
    x: Math.min(...graph.nodes.map((node) => node.position.x)),
    y: Math.min(...graph.nodes.map((node) => node.position.y)),
  };
  const top = Math.min(...[...placed.values()].map((position) => position.y));

  for (const [id, position] of placed) {
    placed.set(id, { x: origin.x + position.x, y: origin.y + position.y - top });
  }

  return placed;
}

/**
 * Column per node: one past the furthest of its sources.
 *
 * Kahn's algorithm over the graph without back-edges. Anything left over sits in
 * a cycle the editor already reports as an error — it still gets a column so the
 * canvas stays laid out while the user untangles it.
 */
function columns(
  dag: Graph,
  index: ReturnType<typeof indexGraph>,
  drawn: Map<string, number>,
): Map<string, number> {
  const column = new Map<string, number>();
  const remaining = new Map(dag.nodes.map((node) => [node.id, (index.incoming.get(node.id) ?? []).length]));
  const ready = dag.nodes.filter((node) => remaining.get(node.id) === 0).map((node) => node.id);

  for (const id of ready) column.set(id, 0);

  while (ready.length > 0) {
    const id = ready.shift()!;
    for (const edge of index.outgoing.get(id) ?? []) {
      column.set(edge.target, Math.max(column.get(edge.target) ?? 0, column.get(id)! + 1));
      const left = remaining.get(edge.target)! - 1;
      remaining.set(edge.target, left);
      if (left === 0) ready.push(edge.target);
    }
  }

  const stranded = dag.nodes
    .filter((node) => !column.has(node.id))
    .sort((a, b) => drawn.get(a.id)! - drawn.get(b.id)!);
  const after = Math.max(-1, ...column.values()) + 1;
  stranded.forEach((node, offset) => column.set(node.id, after + offset));

  return column;
}

/** The average row of a node's sources, or its drawn order when it has none. */
function barycentre(
  id: string,
  index: ReturnType<typeof indexGraph>,
  row: Map<string, number>,
  drawn: Map<string, number>,
): number {
  const rows = (index.incoming.get(id) ?? []).map((edge) => row.get(edge.source)).filter((at) => at !== undefined);
  if (rows.length === 0) return drawn.get(id)!;
  return rows.reduce((total, at) => total + at, 0) / rows.length;
}
