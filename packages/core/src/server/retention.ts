import { prisma } from './db.js';

/**
 * Execution retention.
 *
 * Every node run stores the exact items that went in and came out. Nothing used
 * to delete any of it, so a webhook workflow firing a few times a minute filled
 * the volume and the first anyone heard about it was Postgres refusing writes.
 *
 * Two halves live here: the policy, which an operator sets and the Insights
 * page shows, and the job that enforces it. The job runs on the worker's
 * existing minute tick, deletes in bounded batches so it never holds a long
 * transaction, and is driven through a small store interface so the batching
 * and the budget can be tested without a database.
 */

export interface RetentionPolicy {
  /** Days of successful history to keep, or null to keep it forever. */
  successDays: number | null;
  /** Days of failed and cancelled history to keep, or null to keep it forever. */
  failureDays: number | null;
}

/**
 * What an operator who never opens the setting gets.
 *
 * A week of successes is more than anyone reads back, and a month of failures
 * covers "this broke some time last month" without being the thing that fills
 * the disk: failures are a small fraction of the volume.
 */
export const DEFAULT_POLICY: RetentionPolicy = { successDays: 7, failureDays: 30 };

/** Ten years. Past this, "keep forever" is what is actually meant. */
export const MAX_RETENTION_DAYS = 3650;

const POLICY_ID = 'global';

/** How many executions one pass deletes at a time. */
const BATCH_SIZE = 200;

/**
 * Ceiling on one pass, so a first run against an instance with two years of
 * history spreads the work over several ticks instead of spending a minute of
 * the worker on one enormous delete.
 */
const MAX_PER_PASS = 2_000;

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

export async function getRetentionPolicy(): Promise<RetentionPolicy> {
  const row = await prisma.retentionPolicy.findUnique({ where: { id: POLICY_ID } });
  if (!row) return DEFAULT_POLICY;
  return { successDays: row.successDays, failureDays: row.failureDays };
}

export interface PolicyResult {
  ok: boolean;
  error?: string;
  policy?: RetentionPolicy;
}

export async function setRetentionPolicy(input: RetentionPolicy): Promise<PolicyResult> {
  const successDays = validateDays(input.successDays, 'Successful runs');
  if (typeof successDays === 'string') return { ok: false, error: successDays };

  const failureDays = validateDays(input.failureDays, 'Failed runs');
  if (typeof failureDays === 'string') return { ok: false, error: failureDays };

  const policy: RetentionPolicy = { successDays, failureDays };

  await prisma.retentionPolicy.upsert({
    where: { id: POLICY_ID },
    create: { id: POLICY_ID, ...policy },
    update: policy,
  });

  return { ok: true, policy };
}

/**
 * A day count as it should be stored, or the sentence to show the operator.
 *
 * Returning the message rather than throwing keeps the caller a plain
 * `if`: this is form input, and a bad number is an ordinary answer to give
 * back, not an exception.
 */
function validateDays(value: number | null, label: string): number | null | string {
  if (value === null) return null;
  if (!Number.isInteger(value)) return `${label} needs a whole number of days.`;
  if (value < 1) return `${label} must be kept for at least a day.`;
  if (value > MAX_RETENTION_DAYS) {
    return `${label} cannot be kept for more than ${MAX_RETENTION_DAYS} days. Choose "keep forever" instead.`;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Enforcing it
// ---------------------------------------------------------------------------

/**
 * Statuses aged out on the failure clock.
 *
 * Cancelled sits with the failures rather than the successes: it is a run that
 * did not do what it was asked to, which is the kind anyone comes back to.
 * Queued and running appear nowhere, on either clock — an unfinished run is not
 * history, and deleting one would strand a worker mid-execution.
 */
export const FAILURE_STATUSES = ['failed', 'cancelled'] as const;
export const SUCCESS_STATUSES = ['success'] as const;

export type PrunableStatus = (typeof FAILURE_STATUSES)[number] | (typeof SUCCESS_STATUSES)[number];

export interface PrunePass {
  statuses: readonly PrunableStatus[];
  /** Runs queued before this go. */
  before: Date;
}

/**
 * What this run of the job should delete, given the policy.
 *
 * Pure, and the whole of the "how old is too old" rule. A clock set to null
 * produces no pass at all rather than a pass with an unreachable cutoff, so
 * "keep forever" costs no query.
 */
export function prunePasses(policy: RetentionPolicy, now: Date): PrunePass[] {
  const passes: PrunePass[] = [];

  if (policy.successDays !== null) {
    passes.push({ statuses: SUCCESS_STATUSES, before: daysBefore(now, policy.successDays) });
  }

  if (policy.failureDays !== null) {
    passes.push({ statuses: FAILURE_STATUSES, before: daysBefore(now, policy.failureDays) });
  }

  return passes;
}

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * The database work the job does, behind an interface.
 *
 * Only so the batching and the budget below can be tested without a Postgres:
 * "stops at the budget", "keeps going while a batch comes back full" and "stops
 * when one comes back short" are the parts of this that a bug would be quiet
 * in, and none of them are about SQL.
 */
export interface RetentionStore {
  /** Ids of at most `limit` prunable executions older than the cutoff. */
  findExpired(pass: PrunePass, limit: number): Promise<string[]>;
  /** Delete those executions and everything hanging off them. */
  deleteExecutions(ids: string[]): Promise<number>;
}

export interface PruneOptions {
  now?: Date;
  policy?: RetentionPolicy;
  store?: RetentionStore;
  batchSize?: number;
  maxPerPass?: number;
}

export interface PruneResult {
  deleted: number;
  /** True when the budget ran out with more still to delete. */
  moreToDo: boolean;
}

/**
 * Delete history the policy no longer covers.
 *
 * Batched, and each batch is its own delete rather than one statement over a
 * date range: a long-running delete holds locks on tables the executions list
 * is reading, and an operator noticing retention by watching the UI stall would
 * be a worse bug than the one this fixes.
 */
export async function pruneExecutions(options: PruneOptions = {}): Promise<PruneResult> {
  const now = options.now ?? new Date();
  const policy = options.policy ?? (await getRetentionPolicy());
  const store = options.store ?? prismaStore;
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const budget = options.maxPerPass ?? MAX_PER_PASS;

  let deleted = 0;
  let moreToDo = false;

  for (const pass of prunePasses(policy, now)) {
    while (deleted < budget) {
      const ids = await store.findExpired(pass, Math.min(batchSize, budget - deleted));
      if (ids.length === 0) break;

      deleted += await store.deleteExecutions(ids);

      // A short batch means the cutoff has been reached; a full one means there
      // is probably more behind it.
      if (ids.length < batchSize) break;
    }

    if (deleted >= budget) {
      moreToDo = true;
      break;
    }
  }

  return { deleted, moreToDo };
}

const prismaStore: RetentionStore = {
  async findExpired(pass, limit) {
    const rows = await prisma.execution.findMany({
      where: {
        status: { in: [...pass.statuses] },
        queuedAt: { lt: pass.before },
        // Only roots. A child run is deleted by the cascade from its parent, so
        // taking one on its own would leave a retained parent's detail view
        // linking to a run that no longer exists.
        parentExecutionId: null,
      },
      orderBy: { queuedAt: 'asc' },
      take: limit,
      select: { id: true },
    });

    return rows.map((row) => row.id);
  },

  async deleteExecutions(ids) {
    // NodeRun, BinaryObject and child executions go with the row by cascade.
    // A pin does not: `sourceExecutionId` is deliberately not a foreign key, so
    // retention deleting the run a pin came from cannot delete the pin somebody
    // is working with. It does have to stop pointing at a run that is gone.
    await prisma.pinnedData.updateMany({
      where: { sourceExecutionId: { in: ids } },
      data: { sourceExecutionId: null },
    });

    const { count } = await prisma.execution.deleteMany({ where: { id: { in: ids } } });
    return count;
  },
};

// ---------------------------------------------------------------------------
// What is there
// ---------------------------------------------------------------------------

export interface HistoryVolume {
  executions: number;
  nodeRuns: number;
  /** Bytes of stored files, which is the part that actually grows a volume. */
  binaryBytes: number;
  oldest: Date | null;
}

/**
 * How much history exists, for the operator who would otherwise find out from a
 * disk usage graph.
 */
export async function historyVolume(): Promise<HistoryVolume> {
  const [executions, nodeRuns, binaries, oldest] = await Promise.all([
    prisma.execution.count(),
    prisma.nodeRun.count(),
    prisma.binaryObject.aggregate({ _sum: { size: true } }),
    prisma.execution.findFirst({ orderBy: { queuedAt: 'asc' }, select: { queuedAt: true } }),
  ]);

  return {
    executions,
    nodeRuns,
    binaryBytes: binaries._sum.size ?? 0,
    oldest: oldest?.queuedAt ?? null,
  };
}
