import { telegramApiBase } from '../nodes/impl/telegram.js';
import { loadCredentialData } from './credentials.js';
import { prisma } from './db.js';
import { createExecution } from './executions.js';
import {
  WORKER_ID,
  createPoller,
  groupTriggersByTarget,
  type PollerLog,
  type SubscribedTrigger,
  type TargetGroup,
} from './poller.js';
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
 *
 * The loop, the leasing rhythm and the backoff are `poller.ts`; what is left
 * here is the part that is actually about Telegram.
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

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/** A bot is addressed by the credential holding its token. */
type Bot = string;
type BotGroup = TargetGroup<Bot, TelegramTriggerConfig>;

const poller = createPoller<Bot, TelegramTriggerConfig>({
  name: 'telegram',
  idleMs: IDLE_MS,
  // No interval: getUpdates holds the connection open, which paces the loop.
  minBackoffMs: MIN_BACKOFF_MS,
  maxBackoffMs: MAX_BACKOFF_MS,
  describe: (credentialId) => `bot ${credentialId}`,
  listTargets: () =>
    groupTriggersByTarget<Bot, TelegramTriggerConfig>(
      'telegram',
      (config) => {
        const credentialId = typeof config.credential === 'string' ? config.credential.trim() : '';
        return credentialId === '' ? null : credentialId;
      },
      (credentialId) => credentialId,
    ),
  poll: pollBot,
});

export function startTelegramPoller(log: PollerLog = console.info): void {
  poller.start(log);
}

export async function stopTelegramPoller(): Promise<void> {
  await poller.stop();
}

async function pollBot(group: BotGroup, signal: AbortSignal, log: PollerLog): Promise<boolean> {
  const credentialId = group.target;

  const offset = await takeLease(credentialId);
  // Another worker holds this bot, which is the whole point of the lease.
  if (offset === null) return false;

  try {
    const configs = group.triggers.map((trigger) => trigger.config);
    const updates = await getUpdates(credentialId, offset, allowedUpdatesFor(configs), signal);

    for (const update of updates) {
      await deliver(update, group.triggers, log);
    }

    // The offset is committed only once every execution exists. A crash in
    // between re-delivers the update, which for a chat bot beats losing it.
    //
    // The highest id rather than the last one: Telegram documents them as
    // ascending, but acknowledging less than was handled would replay a run.
    const highest = updates.reduce((max, update) => (update.update_id > max ? update.update_id : max), -1);
    await releaseLease(credentialId, highest >= 0 ? BigInt(highest) + 1n : undefined, null);
    return true;
  } catch (error) {
    // The lease is this file's to let go of either way; the backoff and the log
    // line that follow a failure belong to the loop, so the error carries on up.
    const reason = signal.aborted ? null : error instanceof Error ? error.message : String(error);
    await releaseLease(credentialId, undefined, reason).catch(() => {});
    if (signal.aborted) return false;
    throw error;
  }
}

/** One execution per trigger that wants this update. */
async function deliver(
  update: TelegramUpdate,
  triggers: Array<SubscribedTrigger<TelegramTriggerConfig>>,
  log: PollerLog,
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
