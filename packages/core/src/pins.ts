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
