import type { Prisma } from '@prisma/client';

import { analyseLoops } from '../graph.js';
import type { Graph, Item } from '../types.js';
import { prisma } from './db.js';
import { capturePinnedOutput } from './payload.js';

/**
 * Pinned data: a node output the editor replays instead of running the node.
 *
 * This module is the only door pins go through, in both directions, and that is
 * what keeps a live run away from them. A pin is never read as a side effect of
 * running a workflow — the worker has to ask for it by name, and only a run the
 * editor started does.
 *
 * See docs/pinned-data.md.
 */

export interface PinView {
  nodeId: string;
  items: Item[][];
  truncated: boolean;
  sourceExecutionId: string | null;
  createdAt: string;
}

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

/** Every pin on a workflow, newest first, for the editor to render. */
export async function listPins(workflowId: string): Promise<PinView[]> {
  const rows = await prisma.pinnedData.findMany({
    where: { workflowId },
    orderBy: { createdAt: 'desc' },
  });

  return rows.map((row) => ({
    nodeId: row.nodeId,
    items: asBranches(row.items),
    truncated: row.truncated,
    sourceExecutionId: row.sourceExecutionId,
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * The pins a run may replay, keyed by node id.
 *
 * Filtered against the graph the run will actually use rather than against the
 * working copy: a pin on a node that has since been deleted, or that has moved
 * into a loop, must not reach the runner. The row is left alone — an edit that
 * is undone a minute later should not have destroyed the pin.
 */
export async function pinnedOutputsFor(
  workflowId: string,
  graph: Graph,
): Promise<Record<string, Item[][]>> {
  const rows = await prisma.pinnedData.findMany({
    where: { workflowId },
    select: { nodeId: true, items: true },
  });

  const outputs: Record<string, Item[][]> = {};
  for (const row of rows) {
    if (pinRefusal(graph, row.nodeId) !== null) continue;
    outputs[row.nodeId] = asBranches(row.items);
  }

  return outputs;
}

export interface SetPinInput {
  workflowId: string;
  nodeId: string;
  /** One array per output branch, exactly as the node produced them. */
  items: Item[][];
  /** The run it was captured from, so the editor can say how old it is. */
  sourceExecutionId?: string;
}

export interface SetPinResult {
  ok: boolean;
  error?: string;
  truncated?: boolean;
}

/**
 * Freeze a node's output.
 *
 * The graph is re-read here rather than trusted from the caller, because the
 * refusals above are the difference between a pin that means something and one
 * that silently does nothing on every pass of a loop.
 */
export async function setPin(input: SetPinInput): Promise<SetPinResult> {
  const workflow = await prisma.workflow.findUnique({
    where: { id: input.workflowId },
    select: { graph: true },
  });

  if (!workflow) return { ok: false, error: 'That workflow no longer exists.' };

  const refusal = pinRefusal(workflow.graph as unknown as Graph, input.nodeId);
  if (refusal) return { ok: false, error: refusal };

  const captured = capturePinnedOutput(input.items);

  await prisma.pinnedData.upsert({
    where: { workflowId_nodeId: { workflowId: input.workflowId, nodeId: input.nodeId } },
    create: {
      workflowId: input.workflowId,
      nodeId: input.nodeId,
      items: captured.branches as unknown as Prisma.InputJsonValue,
      truncated: captured.truncated,
      sourceExecutionId: input.sourceExecutionId,
    },
    update: {
      items: captured.branches as unknown as Prisma.InputJsonValue,
      truncated: captured.truncated,
      sourceExecutionId: input.sourceExecutionId ?? null,
      createdAt: new Date(),
    },
  });

  return { ok: true, truncated: captured.truncated };
}

export async function removePin(workflowId: string, nodeId: string): Promise<void> {
  await prisma.pinnedData.deleteMany({ where: { workflowId, nodeId } });
}

/**
 * Drop pins whose node is no longer on the canvas.
 *
 * Called when a graph is saved. Deleting a node and leaving its pin behind would
 * resurrect it the moment a node was added back with the same id, which is
 * exactly what duplicating a workflow does.
 */
export async function prunePinsForGraph(workflowId: string, graph: Graph): Promise<number> {
  const live = graph.nodes.map((node) => node.id);
  const { count } = await prisma.pinnedData.deleteMany({
    where: { workflowId, nodeId: { notIn: live } },
  });
  return count;
}

/**
 * Read a stored payload back as branches.
 *
 * Tolerant of the flat `Item[]` shape on purpose: that is what a node run
 * stores, it is the obvious thing for a caller to pass, and reading it as a
 * single branch is right in every case where it happens.
 */
function asBranches(stored: unknown): Item[][] {
  if (!Array.isArray(stored)) return [];
  if (stored.length === 0) return [];
  return Array.isArray(stored[0]) ? (stored as Item[][]) : [stored as Item[]];
}
