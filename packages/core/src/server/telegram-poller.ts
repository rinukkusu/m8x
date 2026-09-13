import { randomUUID } from 'node:crypto';

import { telegramApiBase } from '../nodes/impl/telegram.js';
import { loadCredentialData } from './credentials.js';
import { prisma } from './db.js';
import { createExecution } from './executions.js';
import {
  allowedUpdatesFor,
  describeUpdate,
  matchesTrigger,
  seedItemFor,
  type TelegramTriggerConfig,
  type TelegramUpdate,
} from './telegram-updates.js';

/**
 * Long polling for Telegram, one poller per bot rather than one per trigger.
 *
 * Telegram allows a single getUpdates call per token at a time, and the offset
 * acknowledges updates for the whole bot rather than for one consumer. Polling
 * per trigger would therefore mean two triggers on one bot stealing each
 * other's messages, and the usual fix is to forbid the second trigger.
 *
 * This does the opposite. The poller owns the bot: it polls once, then hands
 * each update to every trigger whose filters match it. Sharing a bot between
 * five workflows is the supported arrangement, not a conflict to report. One
 * workflow answers /status, another handles photos, a third logs everything,
 * and each is edited and activated on its own.
 */

/** How long a worker holds a bot while polling it. Longer than one poll. */
const LEASE_MS = 90_000;

/** Telegram holds the connection open this long when there is nothing to send. */
const LONG_POLL_SECONDS = 25;

/** The whole request, including Telegram's own wait. */
const REQUEST_TIMEOUT_MS = 35_000;

/** Idle wait when no workflow is listening to Telegram at all. */
const IDLE_MS = 10_000;

/** Backoff after a failed poll, doubling to this ceiling. */
const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

/** This process, so a lease says who holds it. */
const WORKER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

interface SubscribedTrigger {
  workflowId: string;
  nodeId: string;
  config: TelegramTriggerConfig;
}

let controller: AbortController | null = null;
let loop: Promise<void> | null = null;

/** Per-bot backoff, held in memory: a restart should retry immediately. */
const backoff = new Map<string, { until: number; ms: number }>();

export function startTelegramPoller(log: (message: string) => void = console.info): void {
  if (controller) return;
  controller = new AbortController();
  const signal = controller.signal;
  loop = pollForever(signal, log).catch((error) => {
    console.error('[telegram] poller stopped unexpectedly', error);
  });
}

export async function stopTelegramPoller(): Promise<void> {
  if (!controller) return;
  controller.abort();
  controller = null;
  await loop?.catch(() => {});
  loop = null;
  backoff.clear();
}

async function pollForever(signal: AbortSignal, log: (message: string) => void): Promise<void> {
  while (!signal.aborted) {
    let bots: Map<string, SubscribedTrigger[]>;

    try {
      bots = await subscribedBots();
    } catch (error) {
      console.error('[telegram] could not load triggers', error);
      await sleep(IDLE_MS, signal);
      continue;
    }

    if (bots.size === 0) {
      await sleep(IDLE_MS, signal);
      continue;
    }

    // In parallel across bots, since each spends most of its time waiting on
    // Telegram. Within a bot everything stays sequential.
    const polled = await Promise.all(
      [...bots].map(([credentialId, triggers]) => pollBot(credentialId, triggers, signal, log)),
    );

    // Nothing was polled, because every bot is either backing off or held by
    // another worker. Long polling is what normally paces this loop, so without
    // a wait here the losing worker would spin on the database.
    if (!signal.aborted && !polled.includes(true)) await sleep(IDLE_MS, signal);
  }
}

/** Enabled Telegram triggers on active workflows, grouped by bot. */
async function subscribedBots(): Promise<Map<string, SubscribedTrigger[]>> {
  const rows = await prisma.trigger.findMany({
    where: { kind: 'telegram', enabled: true, workflow: { active: true } },
    select: { workflowId: true, nodeId: true, config: true },
  });

  const bots = new Map<string, SubscribedTrigger[]>();

  for (const row of rows) {
    const config = (row.config ?? {}) as TelegramTriggerConfig;
    const credentialId = typeof config.credential === 'string' ? config.credential.trim() : '';
    if (credentialId === '') continue;

    const existing = bots.get(credentialId);
    const trigger: SubscribedTrigger = { workflowId: row.workflowId, nodeId: row.nodeId, config };
    if (existing) existing.push(trigger);
    else bots.set(credentialId, [trigger]);
  }

  return bots;
}

async function pollBot(
  credentialId: string,
  triggers: SubscribedTrigger[],
  signal: AbortSignal,
  log: (message: string) => void,
): Promise<boolean> {
  const waiting = backoff.get(credentialId);
  if (waiting && waiting.until > Date.now()) return false;

  const offset = await takeLease(credentialId);
  // Another worker holds this bot, which is the whole point of the lease.
  if (offset === null) return false;

  try {
    const updates = await getUpdates(credentialId, offset, allowedUpdatesFor(triggers.map((t) => t.config)), signal);

    for (const update of updates) {
      await deliver(update, triggers, log);
    }

    // The offset is committed only once every execution exists. A crash in
    // between re-delivers the update, which for a chat bot beats losing it.
    //
    // The highest id rather than the last one: Telegram documents them as
    // ascending, but acknowledging less than was handled would replay a run.
    const highest = updates.reduce((max, update) => (update.update_id > max ? update.update_id : max), -1);
    await releaseLease(credentialId, highest >= 0 ? BigInt(highest) + 1n : undefined, null);
    backoff.delete(credentialId);
    return true;
  } catch (error) {
    if (signal.aborted) {
      await releaseLease(credentialId, undefined, null).catch(() => {});
      return false;
    }

    const reason = error instanceof Error ? error.message : String(error);
    const previous = backoff.get(credentialId)?.ms ?? 0;
    const ms = Math.min(previous === 0 ? MIN_BACKOFF_MS : previous * 2, MAX_BACKOFF_MS);
    backoff.set(credentialId, { until: Date.now() + ms, ms });

    await releaseLease(credentialId, undefined, reason).catch(() => {});
    log(`[telegram] bot ${credentialId} failed, retrying in ${Math.round(ms / 1000)}s: ${reason}`);
    return false;
  }
}

/** One execution per trigger that wants this update. */
async function deliver(
  update: TelegramUpdate,
  triggers: SubscribedTrigger[],
  log: (message: string) => void,
): Promise<void> {
  const described = describeUpdate(update);
  const item = seedItemFor(update);

  for (const trigger of triggers) {
    if (!matchesTrigger(trigger.config, described)) continue;

    try {
      const { executionId } = await createExecution({
        workflowId: trigger.workflowId,
        trigger: 'telegram',
        input: [item],
        // Named explicitly, so a workflow with two triggers starts at this one.
        triggerNodeId: trigger.nodeId,
      });

      log(`[telegram] queued ${executionId} for workflow ${trigger.workflowId}`);
    } catch (error) {
      // One broken workflow must not stop the update reaching the others, and
      // must not hold up the offset: a workflow that cannot be queued now will
      // not be queueable on a redelivery either.
      console.error(`[telegram] could not queue workflow ${trigger.workflowId}`, error);
    }
  }
}

// ---------------------------------------------------------------------------
// Lease and cursor
// ---------------------------------------------------------------------------

/**
 * Take the bot's lease, returning its offset, or null when another worker has
 * it. The conditional update is the same shape as `claimDueSchedules`: whoever
 * wins the update owns the bot until the lease expires.
 */
async function takeLease(credentialId: string): Promise<bigint | null> {
  const now = new Date();

  try {
    await prisma.telegramBot.upsert({
      where: { credentialId },
      create: { credentialId },
      update: {},
    });
  } catch {
    // Two workers created the row at once. One of them won, which is all the
    // next statement needs.
  }

  const { count } = await prisma.telegramBot.updateMany({
    where: { credentialId, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
    data: { leaseUntil: new Date(now.getTime() + LEASE_MS), leaseOwner: WORKER_ID, lastPolledAt: now },
  });

  if (count !== 1) return null;

  const row = await prisma.telegramBot.findUnique({ where: { credentialId }, select: { offset: true } });
  return row?.offset ?? 0n;
}

async function releaseLease(credentialId: string, offset: bigint | undefined, lastError: string | null): Promise<void> {
  await prisma.telegramBot.updateMany({
    // Only if we still hold it: a lease that expired mid-poll now belongs to
    // someone else, and writing our offset over theirs would replay updates.
    where: { credentialId, leaseOwner: WORKER_ID },
    data: { leaseUntil: null, leaseOwner: null, lastError, ...(offset === undefined ? {} : { offset }) },
  });
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

async function getUpdates(
  credentialId: string,
  offset: bigint,
  allowedUpdates: string[],
  signal: AbortSignal,
): Promise<TelegramUpdate[]> {
  const credential = await loadCredentialData(credentialId);
  const token = credential?.botToken?.trim();
  if (!token) throw new Error('the bot credential is missing or has no token');

  const response = await fetch(`${telegramApiBase()}/bot${token}/getUpdates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      offset: Number(offset),
      timeout: LONG_POLL_SECONDS,
      ...(allowedUpdates.length > 0 ? { allowed_updates: allowedUpdates } : {}),
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });

  const body = (await response.json().catch(() => null)) as
    | { ok?: boolean; result?: unknown; description?: unknown }
    | null;

  if (!response.ok || !body?.ok) {
    const description = typeof body?.description === 'string' ? body.description : `HTTP ${response.status}`;
    // Never include the URL: the token is in it, and this string is stored.
    throw new Error(description);
  }

  return Array.isArray(body.result) ? (body.result as TelegramUpdate[]) : [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number, signal: AbortSignal): Promise<void> {
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
