'use server';

import { EMPTY_GRAPH, type Graph, type Item } from '@m8x/core';
import {
  createExecution,
  createFolder,
  ensureCurrentVersion,
  moveFolder,
  prisma,
  listPins,
  prunePinsForGraph,
  removePin,
  retryExecution,
  setPin,
  subtreeFolderIds,
  syncTriggers,
} from '@m8x/core/server';
import { revalidatePath } from 'next/cache';

import { requireUser } from '@/lib/auth';

/**
 * Every mutation the UI can perform.
 *
 * These are server actions rather than route handlers so the pages can call
 * them directly and rely on `revalidatePath` instead of hand-rolled cache
 * invalidation. Each one re-checks the session: a server action is a public
 * endpoint, and the layout's auth check does not cover it.
 */

export interface ActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function createFolderAction(name: string, parentId: string | null): Promise<ActionResult> {
  await requireUser();

  const trimmed = name.trim();
  if (trimmed === '') return { ok: false, error: 'A folder needs a name.' };

  try {
    const id = await createFolder(trimmed, parentId);
    revalidatePath('/workflows');
    return { ok: true, id };
  } catch (error) {
    return { ok: false, error: describe(error, 'A folder with that name already exists here.') };
  }
}

export async function renameFolderAction(folderId: string, name: string): Promise<ActionResult> {
  await requireUser();

  const trimmed = name.trim();
  if (trimmed === '') return { ok: false, error: 'A folder needs a name.' };

  try {
    await prisma.folder.update({ where: { id: folderId }, data: { name: trimmed } });
    revalidatePath('/workflows');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describe(error, 'A folder with that name already exists here.') };
  }
}

export async function moveFolderAction(folderId: string, parentId: string | null): Promise<ActionResult> {
  await requireUser();

  try {
    await moveFolder(folderId, parentId);
    revalidatePath('/workflows');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describe(error, 'That folder could not be moved.') };
  }
}

/**
 * Deleting a folder keeps its workflows. Losing a workflow because a folder was
 * tidied away would be a far worse surprise than finding it unfiled, so the
 * subtree's workflows move to the root and only the folders go.
 */
export async function deleteFolderAction(folderId: string): Promise<ActionResult> {
  await requireUser();

  const ids = await subtreeFolderIds(folderId);
  if (ids.length === 0) return { ok: false, error: 'That folder no longer exists.' };

  await prisma.$transaction([
    prisma.workflow.updateMany({ where: { folderId: { in: ids } }, data: { folderId: null } }),
    prisma.folder.delete({ where: { id: folderId } }),
  ]);

  revalidatePath('/workflows');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

export async function createWorkflowAction(name: string, folderId: string | null): Promise<ActionResult> {
  await requireUser();

  const workflow = await prisma.workflow.create({
    data: {
      name: name.trim() === '' ? 'Untitled workflow' : name.trim(),
      folderId,
      // Every new workflow gets a manual trigger, because an empty canvas with
      // no way to press Run is a bad first thirty seconds.
      graph: {
        nodes: [
          {
            id: 'trigger',
            type: 'trigger.manual',
            name: 'When clicking Run',
            position: { x: 0, y: 0 },
            params: {},
          },
        ],
        edges: [],
      } satisfies Graph as never,
    },
    select: { id: true },
  });

  revalidatePath('/workflows');
  return { ok: true, id: workflow.id };
}

export async function renameWorkflowAction(workflowId: string, name: string): Promise<ActionResult> {
  await requireUser();

  const trimmed = name.trim();
  if (trimmed === '') return { ok: false, error: 'A workflow needs a name.' };

  await prisma.workflow.update({ where: { id: workflowId }, data: { name: trimmed } });
  revalidatePath('/workflows');
  revalidatePath(`/workflows/${workflowId}`);
  return { ok: true };
}

export async function moveWorkflowAction(workflowId: string, folderId: string | null): Promise<ActionResult> {
  await requireUser();

  await prisma.workflow.update({ where: { id: workflowId }, data: { folderId } });
  revalidatePath('/workflows');
  return { ok: true };
}

export async function deleteWorkflowAction(workflowId: string): Promise<ActionResult> {
  await requireUser();

  await prisma.workflow.delete({ where: { id: workflowId } });
  revalidatePath('/workflows');
  return { ok: true };
}

/**
 * Save the graph.
 *
 * Trigger rows are reconciled on every save rather than only on activation, so
 * the webhook URL shown in the editor is correct the moment you type a path.
 */
export async function saveGraphAction(workflowId: string, graph: Graph): Promise<ActionResult> {
  await requireUser();

  const workflow = await prisma.workflow.update({
    where: { id: workflowId },
    data: { graph: graph as never },
    select: { id: true, active: true },
  });

  const sync = await syncTriggers(workflowId, graph, workflow.active);
  // A pin belongs to the node it was taken from. Leaving one behind would
  // resurrect it if a node ever reappeared under the same id.
  await prunePinsForGraph(workflowId, graph);

  revalidatePath(`/workflows/${workflowId}`);
  revalidatePath('/workflows');

  if (sync.conflicts.length > 0) {
    const paths = sync.conflicts.map((conflict) => conflict.path).join(', ');
    return { ok: true, error: `Saved, but another workflow already uses the webhook path ${paths}.` };
  }

  return { ok: true };
}

export async function setActiveAction(workflowId: string, active: boolean): Promise<ActionResult> {
  await requireUser();

  const workflow = await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } });
  const graph = workflow.graph as unknown as Graph;

  if (active) {
    const hasRealTrigger = graph.nodes.some(
      (node) => node.type.startsWith('trigger.') && node.type !== 'trigger.manual' && !node.disabled,
    );
    if (!hasRealTrigger) {
      return {
        ok: false,
        error:
          'Add a Webhook, Schedule or Telegram trigger before activating. A manual trigger only runs when you click Run.',
      };
    }
  }

  await prisma.workflow.update({ where: { id: workflowId }, data: { active } });
  const sync = await syncTriggers(workflowId, graph, active);

  revalidatePath(`/workflows/${workflowId}`);
  revalidatePath('/workflows');

  if (active && sync.conflicts.length > 0) {
    return { ok: false, error: `The webhook path ${sync.conflicts[0]!.path} is already taken by another workflow.` };
  }

  // Activating with pins left on is not an error — a live run ignores them —
  // but it is the moment somebody finds out their tested workflow and their
  // real one are not the same thing, so say which nodes are affected.
  if (active) {
    const pinned = await listPins(workflowId);
    const live = new Set(graph.nodes.map((node) => node.id));
    const names = pinned
      .filter((pin) => live.has(pin.nodeId))
      .map((pin) => graph.nodes.find((node) => node.id === pin.nodeId)?.name ?? pin.nodeId);

    if (names.length > 0) {
      return {
        ok: true,
        error: `Active. ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} still pinned — this workflow will run ${names.length === 1 ? 'it' : 'them'} for real, not replay the pinned items.`,
      };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export interface RunOptions {
  /**
   * Replay the workflow's pinned data instead of running the nodes it covers.
   * The editor sets this; nothing else can, which is what keeps a triggered run
   * away from pinned data.
   */
  usePinnedData?: boolean;
  /** Start here instead of at the top, taking the input from upstream pins. */
  resumeFromNodeId?: string;
}

export async function runWorkflowAction(
  workflowId: string,
  graph?: Graph,
  options: RunOptions = {},
): Promise<ActionResult> {
  await requireUser();

  // Running from the editor saves first. Otherwise Run would execute the last
  // saved version while the canvas shows something else, which is the single
  // most confusing thing a workflow editor can do.
  if (graph) {
    const saved = await prisma.workflow.update({
      where: { id: workflowId },
      data: { graph: graph as never },
      select: { currentVersionId: true, active: true },
    });
    await ensureCurrentVersion(workflowId, graph, saved.currentVersionId);
    await syncTriggers(workflowId, graph, saved.active);
    await prunePinsForGraph(workflowId, graph);
  }

  try {
    const { executionId } = await createExecution({
      workflowId,
      trigger: 'manual',
      input: [{ json: {} }],
      usePinnedData: options.usePinnedData,
      resumeFromNodeId: options.resumeFromNodeId,
    });

    revalidatePath('/executions');
    return { ok: true, id: executionId };
  } catch (error) {
    return { ok: false, error: describe(error, 'The run could not be queued.') };
  }
}

/**
 * The state of a run, for the editor to poll while it is in flight.
 *
 * The editor polls rather than holding a socket, the same as the execution
 * detail view and for the same reason: a three-second refresh on a page nobody
 * leaves open for hours is not worth the machinery.
 */
export interface RunStateView {
  id: string;
  status: string;
  errorNodeId: string | null;
  errorNodeName: string | null;
  errorType: string | null;
  errorMessage: string | null;
  runs: Array<{
    id: string;
    nodeId: string;
    nodeName: string;
    nodeType: string;
    status: string;
    attempt: number;
    iteration: number;
    sequence: number;
    durationMs: number | null;
    startedAt: string;
    input: unknown;
    output: unknown;
    inputTruncated: boolean;
    outputTruncated: boolean;
    error: unknown;
  }>;
}

export async function runStateAction(executionId: string): Promise<RunStateView | null> {
  await requireUser();

  const execution = await prisma.execution.findUnique({
    where: { id: executionId },
    include: { nodeRuns: { orderBy: { sequence: 'asc' } } },
  });

  if (!execution) return null;

  return {
    id: execution.id,
    status: execution.status,
    errorNodeId: execution.errorNodeId,
    errorNodeName: execution.errorNodeName,
    errorType: execution.errorType,
    errorMessage: execution.errorMessage,
    runs: execution.nodeRuns.map((run) => ({
      id: run.id,
      nodeId: run.nodeId,
      nodeName: run.nodeName,
      nodeType: run.nodeType,
      status: run.status,
      attempt: run.attempt,
      iteration: run.iteration,
      sequence: run.sequence,
      durationMs: run.durationMs,
      startedAt: run.startedAt.toISOString(),
      input: run.input,
      output: run.output,
      inputTruncated: run.inputTruncated,
      outputTruncated: run.outputTruncated,
      error: run.error,
    })),
  };
}

// ---------------------------------------------------------------------------
// Pinned data
// ---------------------------------------------------------------------------

/**
 * Freeze what a node produced.
 *
 * The items come from a NodeRun rather than from the caller, so a pin is always
 * something the workflow really produced. Trusting a payload posted from the
 * browser would make this an endpoint for writing arbitrary items into a run.
 */
export async function pinNodeOutputAction(
  workflowId: string,
  nodeId: string,
  nodeRunId: string,
): Promise<ActionResult> {
  await requireUser();

  const run = await prisma.nodeRun.findUnique({
    where: { id: nodeRunId },
    select: { nodeId: true, output: true, executionId: true, execution: { select: { workflowId: true } } },
  });

  if (!run || run.nodeId !== nodeId || run.execution.workflowId !== workflowId) {
    return { ok: false, error: 'That run is not this node\'s.' };
  }

  const items = Array.isArray(run.output) ? (run.output as unknown as Item[]) : [];
  if (items.length === 0) {
    return { ok: false, error: 'That run produced no items, so there is nothing to pin.' };
  }

  const result = await setPin({
    workflowId,
    nodeId,
    // NodeRun flattens the branches for display, so this is the one branch a
    // pin can restore — the same limitation that makes a retry from downstream
    // of an If start at the If.
    items: [items],
    sourceExecutionId: run.executionId,
  });

  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath(`/workflows/${workflowId}`);

  return result.truncated
    ? { ok: true, error: 'Pinned, but only part of that payload was stored. The rest is not in the pin.' }
    : { ok: true };
}

export async function unpinNodeAction(workflowId: string, nodeId: string): Promise<ActionResult> {
  await requireUser();
  await removePin(workflowId, nodeId);
  revalidatePath(`/workflows/${workflowId}`);
  return { ok: true };
}

export async function retryExecutionAction(executionId: string, fromFailedNode: boolean): Promise<ActionResult> {
  await requireUser();

  try {
    const id = await retryExecution(executionId, { fromFailedNode });
    revalidatePath('/executions');
    return { ok: true, id };
  } catch (error) {
    return { ok: false, error: describe(error, 'The retry could not be queued.') };
  }
}

export async function cancelExecutionAction(executionId: string): Promise<ActionResult> {
  await requireUser();

  // Only queued runs can be pulled back. Stopping one mid-flight needs the
  // worker to cooperate, which is a later problem.
  const { count } = await prisma.execution.updateMany({
    where: { id: executionId, status: 'queued' },
    data: { status: 'cancelled', finishedAt: new Date() },
  });

  revalidatePath('/executions');
  return count === 1 ? { ok: true } : { ok: false, error: 'That run has already started.' };
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message && !error.message.includes('Invalid `prisma')) {
    return error.message;
  }
  return fallback;
}
