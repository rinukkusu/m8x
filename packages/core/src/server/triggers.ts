import { CronExpressionParser } from 'cron-parser';

import type { Graph } from '../types.js';
import { prisma } from './db.js';

/**
 * Keeping Trigger rows in step with the graph.
 *
 * Triggers are derived state: the graph is the source of truth, and these rows
 * exist only so the webhook route can resolve a path without loading every
 * workflow, and so the scheduler can find due work with an index instead of a
 * scan. Every save reconciles them.
 */

export interface SyncResult {
  created: number;
  updated: number;
  removed: number;
  /** Paths that another workflow already owns. */
  conflicts: Array<{ nodeId: string; path: string }>;
}

export async function syncTriggers(workflowId: string, graph: Graph, active: boolean): Promise<SyncResult> {
  const wanted = graph.nodes.filter((node) => node.type.startsWith('trigger.') && !node.disabled);
  const existing = await prisma.trigger.findMany({ where: { workflowId } });
  const existingByNode = new Map(existing.map((row) => [row.nodeId, row]));

  const result: SyncResult = { created: 0, updated: 0, removed: 0, conflicts: [] };
  const keptNodeIds = new Set<string>();

  for (const node of wanted) {
    if (node.type === 'trigger.manual') continue;

    const kind = node.type === 'trigger.webhook' ? 'webhook' : 'schedule';
    const webhookPath = kind === 'webhook' ? normalisePath(node.params.path) : null;

    if (kind === 'webhook') {
      if (!webhookPath) continue;
      const owner = await prisma.trigger.findUnique({ where: { webhookPath }, select: { workflowId: true, nodeId: true } });
      if (owner && (owner.workflowId !== workflowId || owner.nodeId !== node.id)) {
        // Refusing beats silently stealing the path from the other workflow,
        // which would break it with no visible cause.
        result.conflicts.push({ nodeId: node.id, path: webhookPath });
        continue;
      }
    }

    const nextRunAt = kind === 'schedule' && active ? computeNextRun(node.params, new Date()) : null;
    const current = existingByNode.get(node.id);
    keptNodeIds.add(node.id);

    if (current) {
      await prisma.trigger.update({
        where: { id: current.id },
        data: {
          kind,
          config: node.params as never,
          webhookPath,
          enabled: active,
          // Only reset the due time when the schedule itself changed, so
          // toggling an unrelated setting does not skip a run.
          nextRunAt: scheduleChanged(current.config, node.params) || !current.nextRunAt ? nextRunAt : current.nextRunAt,
        },
      });
      result.updated++;
      continue;
    }

    await prisma.trigger.create({
      data: {
        workflowId,
        nodeId: node.id,
        kind,
        config: node.params as never,
        webhookPath,
        enabled: active,
        nextRunAt,
      },
    });
    result.created++;
  }

  const stale = existing.filter((row) => !keptNodeIds.has(row.nodeId));
  if (stale.length > 0) {
    await prisma.trigger.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
    result.removed = stale.length;
  }

  return result;
}

/**
 * Claim every schedule trigger that is due and move its next run forward.
 *
 * The update is conditional on `nextRunAt` still being in the past, so if two
 * workers tick at the same moment only one of them claims each trigger.
 */
export async function claimDueSchedules(now = new Date()): Promise<Array<{ workflowId: string; nodeId: string }>> {
  const due = await prisma.trigger.findMany({
    where: { kind: 'schedule', enabled: true, nextRunAt: { lte: now } },
    select: { id: true, workflowId: true, nodeId: true, config: true, nextRunAt: true },
  });

  const claimed: Array<{ workflowId: string; nodeId: string }> = [];

  for (const trigger of due) {
    const next = computeNextRun(trigger.config as Record<string, unknown>, now);

    const { count } = await prisma.trigger.updateMany({
      where: { id: trigger.id, nextRunAt: trigger.nextRunAt },
      data: { nextRunAt: next, lastRunAt: now },
    });

    if (count === 1) claimed.push({ workflowId: trigger.workflowId, nodeId: trigger.nodeId });
  }

  return claimed;
}

export function computeNextRun(config: Record<string, unknown> | unknown, from: Date): Date | null {
  const params = (config ?? {}) as Record<string, unknown>;
  const mode = typeof params.mode === 'string' ? params.mode : 'interval';

  if (mode === 'interval') {
    const minutes = Number(params.intervalMinutes ?? 15);
    if (!Number.isFinite(minutes) || minutes < 1) return null;
    return new Date(from.getTime() + minutes * 60_000);
  }

  const expression = typeof params.cron === 'string' ? params.cron.trim() : '';
  if (expression === '') return null;

  try {
    const tz = typeof params.timezone === 'string' && params.timezone.trim() !== '' ? params.timezone.trim() : 'UTC';
    return CronExpressionParser.parse(expression, { currentDate: from, tz }).next().toDate();
  } catch {
    // A bad cron expression disables the schedule rather than crashing the
    // tick. The workflow's activation check surfaces it to the author.
    return null;
  }
}

export function isValidCron(expression: string, timezone = 'UTC'): boolean {
  try {
    CronExpressionParser.parse(expression, { tz: timezone });
    return true;
  } catch {
    return false;
  }
}

/** The webhook URL shown in the editor. */
export function webhookUrlFor(path: string): string {
  const base = process.env.M8X_PUBLIC_URL ?? 'http://localhost:3000';
  return `${base.replace(/\/$/, '')}/api/webhooks/${path}`;
}

function normalisePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return null;
  // Keep it to one URL-safe segment so the route stays unambiguous.
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

function scheduleChanged(before: unknown, after: Record<string, unknown>): boolean {
  const a = (before ?? {}) as Record<string, unknown>;
  const keys = ['mode', 'intervalMinutes', 'cron', 'timezone'];
  return keys.some((key) => a[key] !== after[key]);
}
