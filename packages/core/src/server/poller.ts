import { randomUUID } from 'node:crypto';

import type { TriggerKind } from '@prisma/client';

import { prisma } from './db.js';

/**
 * The shape every polled trigger shares.
 *
 * Telegram and IMAP have almost nothing in common at the protocol level, and
 * everything in common around it: load the triggers that are switched on, group
 * them by whatever owns the cursor, poll each group in parallel, lease the
 * group so two workers cannot poll it at once, and back off the ones that fail
 * without letting them hold up the ones that do not. That outline is here; what
 * a poll actually does, and where the cursor is kept, stays with the
 * integration, because that is the part that genuinely differs.
 */

export type PollerLog = (message: string) => void;

/** This process, so a lease can say who holds it. */
export const WORKER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;

/** One trigger node that wants what a poll finds. */
export interface SubscribedTrigger<TConfig> {
  workflowId: string;
  nodeId: string;
  config: TConfig;
}

/**
 * Everything listening to one pollable thing — a bot, a mail folder.
 *
 * Polling is per target rather than per trigger because the cursor belongs to
 * the target: two triggers reading one inbox independently would each move a
 * position the other also owns, and steal each other's mail. Polling once and
 * handing the result to everyone that matches makes sharing supported instead.
 */
export interface TargetGroup<TTarget, TConfig> {
  target: TTarget;
  triggers: Array<SubscribedTrigger<TConfig>>;
}

export interface PollerSpec<TTarget, TConfig> {
  /** Log prefix, and the name used when something goes wrong. */
  name: string;
  /** Wait when nothing is subscribed, or when no target could be polled. */
  idleMs: number;
  /**
   * Wait after every pass. Leave unset when the poll paces the loop itself, as
   * a long poll does — then `idleMs` covers only the passes that did nothing.
   */
  intervalMs?: number;
  /** Backoff after a failed poll, doubling from the first to the second. */
  minBackoffMs: number;
  maxBackoffMs: number;
  /** The targets with something listening to them, keyed for the backoff map. */
  listTargets(): Promise<Map<string, TargetGroup<TTarget, TConfig>>>;
  /**
   * Poll one target. True when it was actually polled, false when the lease
   * belonged to another worker and there was nothing to do.
   *
   * Throwing is how a failure is reported: the loop turns it into backoff and a
   * log line. Releasing the lease on the way out belongs to the implementation,
   * which is the half that knows where the cursor lives.
   */
  poll(
    group: TargetGroup<TTarget, TConfig>,
    signal: AbortSignal,
    log: PollerLog,
  ): Promise<boolean>;
  /** How to name a target in a log line, e.g. "bot abc" or "INBOX". */
  describe(target: TTarget): string;
}

export interface Poller {
  start(log?: PollerLog): void;
  stop(): Promise<void>;
}

export function createPoller<TTarget, TConfig>(spec: PollerSpec<TTarget, TConfig>): Poller {
  let controller: AbortController | null = null;
  let loop: Promise<void> | null = null;

  /** Per-target backoff, held in memory: a restart should retry immediately. */
  const backoff = new Map<string, { until: number; ms: number }>();

  async function pollOne(
    key: string,
    group: TargetGroup<TTarget, TConfig>,
    signal: AbortSignal,
    log: PollerLog,
  ): Promise<boolean> {
    const waiting = backoff.get(key);
    if (waiting && waiting.until > Date.now()) return false;

    try {
      const polled = await spec.poll(group, signal, log);
      if (polled) backoff.delete(key);
      return polled;
    } catch (error) {
      // A poll interrupted by shutdown is not a failure to back off from.
      if (signal.aborted) return false;

      const reason = error instanceof Error ? error.message : String(error);
      const previous = backoff.get(key)?.ms ?? 0;
      const ms = Math.min(previous === 0 ? spec.minBackoffMs : previous * 2, spec.maxBackoffMs);
      backoff.set(key, { until: Date.now() + ms, ms });

      log(
        `[${spec.name}] ${spec.describe(group.target)} failed, retrying in ${Math.round(ms / 1000)}s: ${reason}`,
      );
      return false;
    }
  }

  async function pollForever(signal: AbortSignal, log: PollerLog): Promise<void> {
    while (!signal.aborted) {
      let targets: Map<string, TargetGroup<TTarget, TConfig>>;

      try {
        targets = await spec.listTargets();
      } catch (error) {
        console.error(`[${spec.name}] could not load triggers`, error);
        await sleep(spec.idleMs, signal);
        continue;
      }

      // A target nobody is listening to any more — trigger deleted, workflow
      // switched off — keeps no backoff. Without this the map is a slow leak
      // for the life of the process, and a target that comes back later would
      // still be serving out a wait from before it went away.
      for (const key of backoff.keys()) {
        if (!targets.has(key)) backoff.delete(key);
      }

      if (targets.size === 0) {
        await sleep(spec.idleMs, signal);
        continue;
      }

      // In parallel across targets, since each spends most of its time waiting
      // on a server. Within one target everything stays sequential.
      const polled = await Promise.all(
        [...targets].map(([key, group]) => pollOne(key, group, signal, log)),
      );

      if (signal.aborted) break;

      if (spec.intervalMs !== undefined) {
        await sleep(spec.intervalMs, signal);
      } else if (!polled.includes(true)) {
        // Nothing was polled, because every target is either backing off or
        // held by another worker. The poll itself normally paces this loop, so
        // without a wait here the losing worker would spin on the database.
        await sleep(spec.idleMs, signal);
      }
    }
  }

  return {
    start(log = console.info) {
      if (controller) return;
      controller = new AbortController();
      const signal = controller.signal;
      loop = pollForever(signal, log).catch((error: unknown) => {
        console.error(`[${spec.name}] poller stopped unexpectedly`, error);
      });
    },

    async stop() {
      if (!controller) return;
      controller.abort();
      controller = null;
      await loop?.catch(() => {});
      loop = null;
      backoff.clear();
    },
  };
}

/**
 * Load the triggers of one kind that are switched on, grouped by target.
 *
 * A trigger whose config names no target — a node saved before its credential
 * was picked — is left out rather than being an error: it is a half-finished
 * node on an active workflow, which is a normal thing to be looking at.
 */
export async function groupTriggersByTarget<TTarget, TConfig>(
  kind: TriggerKind,
  targetOf: (config: TConfig) => TTarget | null,
  keyOf: (target: TTarget) => string,
): Promise<Map<string, TargetGroup<TTarget, TConfig>>> {
  const rows = await prisma.trigger.findMany({
    where: { kind, enabled: true, workflow: { active: true } },
    select: { workflowId: true, nodeId: true, config: true },
  });

  const groups = new Map<string, TargetGroup<TTarget, TConfig>>();

  for (const row of rows) {
    const config = (row.config ?? {}) as TConfig;
    const target = targetOf(config);
    if (target === null) continue;

    const trigger: SubscribedTrigger<TConfig> = {
      workflowId: row.workflowId,
      nodeId: row.nodeId,
      config,
    };

    const existing = groups.get(keyOf(target));
    if (existing) existing.triggers.push(trigger);
    else groups.set(keyOf(target), { target, triggers: [trigger] });
  }

  return groups;
}

/** A wait that gives up when the poller is shutting down. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });

    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
