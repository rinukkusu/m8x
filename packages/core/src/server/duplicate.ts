import type { Prisma } from '@prisma/client';

import type { Graph } from '../types.js';
import { prisma } from './db.js';
import { normaliseWebhookPath, syncTriggers } from './triggers.js';

/**
 * Duplicating a workflow.
 *
 * The copy takes the working graph — nodes, parameters, connections, credential
 * and datatable references — and nothing else. What it deliberately leaves
 * behind is the interesting part:
 *
 * - **Active state.** A duplicate is always inactive. Copying a live workflow
 *   and having the copy immediately answer the same schedule or the same
 *   webhook would be a destructive surprise, and it is the one mistake here
 *   that fires side effects in the real world.
 * - **Execution history**, which belongs to the workflow that produced it, and
 *   **version history**, which the copy starts fresh.
 * - **Trigger identity.** Anything a trigger owns uniquely has to be reissued
 *   rather than shared, or two workflows fight over the same ingress.
 * - **Pinned data.** A pin is scratch data belonging to one person editing one
 *   workflow — the same reason it does not live in the graph and would not
 *   travel in an export.
 */

export interface DuplicateResult {
  ok: boolean;
  error?: string;
  id?: string;
  name?: string;
}

export async function duplicateWorkflow(workflowId: string): Promise<DuplicateResult> {
  const original = await prisma.workflow.findUnique({
    where: { id: workflowId },
    select: { name: true, folderId: true, graph: true },
  });

  if (!original) return { ok: false, error: 'That workflow no longer exists.' };

  const graph = original.graph as unknown as Graph;

  // Siblings only. Two workflows in different folders sharing a name is not a
  // collision anybody trips over, and there is no unique constraint to satisfy
  // — this is about the copy landing somewhere obvious with a name that says
  // what it is.
  const siblings = await prisma.workflow.findMany({
    where: { folderId: original.folderId },
    select: { name: true },
  });

  const name = copyName(original.name, siblings.map((sibling) => sibling.name));
  const copied = await reissueTriggerIdentity(graph, freeWebhookPath);

  const workflow = await prisma.workflow.create({
    data: {
      name,
      folderId: original.folderId,
      // Never active, whatever the original was.
      active: false,
      graph: copied as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  // Inactive, so a schedule gets no due time and a webhook row is registered
  // but disabled. The rows still have to exist: the editor reads them to show
  // the copy's own webhook URL.
  const sync = await syncTriggers(workflow.id, copied, false);

  if (sync.conflicts.length > 0) {
    // Only reachable if something claimed a path between minting it and saving.
    // The copy exists and is inactive, so saying so beats rolling it back.
    return {
      ok: true,
      id: workflow.id,
      name,
      error: `Copied, but the webhook path ${sync.conflicts[0]!.path} was taken in the meantime. Give it a new one before activating.`,
    };
  }

  return { ok: true, id: workflow.id, name };
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** " (copy)" or " (copy 4)" at the end of a name. */
const COPY_SUFFIX = /\s*\(copy(?:\s+(\d+))?\)$/i;

/**
 * A name for the copy that says what it is and collides with nothing.
 *
 * The suffix is stripped before counting, so duplicating "Orders (copy)" gives
 * "Orders (copy 2)" rather than "Orders (copy) (copy)" — the second one is what
 * you get by not thinking about it, and it degrades fast.
 */
export function copyName(original: string, taken: Iterable<string>): string {
  const stem = original.replace(COPY_SUFFIX, '').trim() || original.trim();
  const used = new Set([...taken].map((name) => name.trim().toLowerCase()));

  const first = `${stem} (copy)`;
  if (!used.has(first.toLowerCase())) return first;

  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} (copy ${n})`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }

  // A thousand copies of one workflow is not a case worth a cleverer scheme.
  return `${stem} (copy ${Date.now()})`;
}

// ---------------------------------------------------------------------------
// Trigger identity
// ---------------------------------------------------------------------------

/**
 * Which trigger kinds own something that two workflows cannot share.
 *
 * Only the webhook does, and it is worth writing down why the others do not:
 *
 * - **Schedule** owns nothing. Two workflows on the same cron is ordinary.
 * - **Telegram** is shared *by design*: a bot is polled once and its messages
 *   are handed to every trigger listening, which is the feature that lets one
 *   bot back five workflows.
 * - **Email** works the same way — the cursor belongs to the mailbox, not to
 *   the workflow reading it.
 * - **Datatable** references a table, and a table is shared state already.
 *
 * A webhook path is different: `Trigger.webhookPath` is unique, so the copy
 * would either steal the ingress or fail to register at all.
 */
export async function reissueTriggerIdentity(
  graph: Graph,
  issuePath: (current: string, claimed: ReadonlySet<string>) => Promise<string>,
): Promise<Graph> {
  // Every path this graph already spells, disabled nodes included. A disabled
  // webhook has no Trigger row to collide with, so the database cannot rule it
  // out — but it is one un-disable away from being a real ingress, and handing
  // the copy the same path would make that a surprise rather than a choice.
  const claimed = new Set(
    graph.nodes
      .filter((node) => node.type === 'trigger.webhook')
      .map((node) => normaliseWebhookPath(node.params.path))
      .filter((path): path is string => path !== null),
  );

  const nodes: Graph['nodes'] = [];

  // One at a time, not `Promise.all`. Minting reserves nothing in the database,
  // so two nodes asking concurrently — which two webhooks sharing a stem do —
  // would be handed the same new path, and one of them would silently lose its
  // trigger.
  for (const node of graph.nodes) {
    if (node.type !== 'trigger.webhook') {
      nodes.push(node);
      continue;
    }

    const current = normaliseWebhookPath(node.params.path);
    // Nothing to reissue: an unconfigured webhook registers no row, so the copy
    // can carry the empty path across and be configured like any new one.
    // Minting a path here would invent an ingress nobody asked for.
    if (!current) {
      nodes.push(node);
      continue;
    }

    const issued = await issuePath(current, claimed);
    claimed.add(issued);
    nodes.push({ ...node, params: { ...node.params, path: issued } });
  }

  return { ...graph, nodes };
}

/**
 * Candidate paths for a copy of `current`, most readable first.
 *
 * Derived from the original rather than random, because the path is a URL
 * somebody has to recognise in a log: "orders-created-copy" says what it is
 * where "a7f3c1" does not.
 */
export function webhookPathCandidates(current: string): string[] {
  const stem = current.replace(/-copy(?:-\d+)?$/i, '');
  const candidates = [`${stem}-copy`];
  for (let n = 2; n <= 50; n++) candidates.push(`${stem}-copy-${n}`);
  // Stripping the suffix and adding it back gives `current` itself for anything
  // already ending in "-copy". Handing that back is the one answer this must
  // never give: it is the original's own path.
  return candidates.filter((candidate) => candidate !== current);
}

/**
 * The first candidate path no trigger already holds.
 *
 * Racy by nature — another workflow can claim one between this check and the
 * insert — which is why `syncTriggers` reports a conflict rather than trusting
 * it, and why the copy is created inactive either way.
 */
async function freeWebhookPath(current: string, claimed: ReadonlySet<string>): Promise<string> {
  const candidates = webhookPathCandidates(current);

  const taken = await prisma.trigger.findMany({
    where: { webhookPath: { in: candidates } },
    select: { webhookPath: true },
  });

  const used = new Set<string | null>(taken.map((row) => row.webhookPath));
  // `claimed` covers what no query can see: paths this same copy has already
  // been handed, and paths its own disabled webhook nodes are holding.
  const free = candidates.find((candidate) => !used.has(candidate) && !claimed.has(candidate));

  // Fifty copies of one webhook and every readable name gone. A suffix nobody
  // has to read beats refusing to duplicate.
  return free ?? `${current}-copy-${Date.now().toString(36)}`;
}
