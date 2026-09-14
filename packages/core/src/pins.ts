import { analyseLoops } from './graph.js';
import type { Graph } from './types.js';

/**
 * Which nodes may hold a pin.
 *
 * Pure graph logic, and out here rather than beside the storage so the editor
 * can ask before offering the button. A refusal the user only discovers after
 * clicking is a worse version of the same answer.
 *
 * See docs/pinned-data.md.
 */

/**
 * Why a node cannot be pinned, or null when it can.
 *
 * Returned rather than thrown: the editor asks this to decide whether to offer
 * the button, and a refusal is a normal answer rather than an error.
 */
export function pinRefusal(graph: Graph, nodeId: string): string | null {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return 'That node is not in this workflow any more.';

  const loops = analyseLoops(graph);
  if (loops.regions.has(nodeId)) {
    return 'A Loop Over Items node is handed its batch on every pass, so a pin would have nowhere to take effect.';
  }

  for (const region of loops.regions.values()) {
    if (region.has(nodeId)) {
      return 'This node is inside a loop, and it runs once per pass. A pin would freeze every pass to the same items.';
    }
  }

  return null;
}

/**
 * Why a run cannot start at a node, or null when it can.
 *
 * A run from here takes the node's input from the pins above it, so every node
 * feeding it has to be pinned. Without that it gathers input from nodes that
 * were skipped and never produced anything, and the run does nothing while
 * looking like it worked — which is the failure this exists to prevent.
 */
export function resumeRefusal(graph: Graph, nodeId: string, pinned: ReadonlySet<string>): string | null {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return 'That node is not in this workflow any more.';

  const loops = analyseLoops(graph);
  const insideLoop = [...loops.regions.values()].some((region) => region.has(nodeId));
  if (insideLoop || loops.regions.has(nodeId)) {
    // The outer order steps over a loop region as one unit, so there is nowhere
    // to express "start at pass four". The same reason a retry from inside a
    // loop restarts the whole run.
    return 'A run cannot start inside a loop: there is no way to say which pass to start at.';
  }

  const feeding = graph.edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source);
  if (feeding.length === 0) {
    return 'Nothing feeds this node, so a run from here is the same as a run from the top.';
  }

  const missing = [...new Set(feeding)].filter((id) => !pinned.has(id));
  if (missing.length === 0) return null;

  const names = missing.map((id) => graph.nodes.find((candidate) => candidate.id === id)?.name ?? id);
  return `Pin ${names.join(', ')} first — a run from here takes this node's input from the pins above it.`;
}
