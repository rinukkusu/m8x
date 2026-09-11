import PgBoss from 'pg-boss';

/**
 * The job queue.
 *
 * pg-boss rather than BullMQ so the whole stack stays at one stateful service.
 * Everything here goes through a small interface on purpose: if throughput ever
 * outgrows Postgres, swapping in Redis should touch this file and nothing else.
 */

export const QUEUE_EXECUTE = 'workflow.execute';
export const QUEUE_SCHEDULER_TICK = 'scheduler.tick';

export interface ExecuteJob {
  executionId: string;
}

let boss: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  if (starting) return starting;

  starting = (async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set.');

    const instance = new PgBoss({
      connectionString,
      // Jobs live in their own schema so `prisma migrate` never sees them and
      // never tries to drop them.
      schema: 'pgboss',
      // A run that has been going for an hour is stuck, not slow.
      retryLimit: 0,
    });

    instance.on('error', (error) => {
      console.error('[queue] pg-boss error', error);
    });

    await instance.start();
    await instance.createQueue(QUEUE_EXECUTE);
    await instance.createQueue(QUEUE_SCHEDULER_TICK);

    boss = instance;
    return instance;
  })();

  return starting;
}

/** Hand an execution to the worker. The row must already exist. */
export async function enqueueExecution(job: ExecuteJob): Promise<void> {
  const instance = await getBoss();
  await instance.send(QUEUE_EXECUTE, job, {
    // The runner does its own retrying per node. A queue-level retry would
    // re-run the whole workflow, firing every side effect a second time.
    retryLimit: 0,
    expireInMinutes: 60,
  });
}

/**
 * One schedule for the whole system rather than one per workflow.
 *
 * pg-boss keys schedules by queue name, so per-workflow crons would mean
 * creating a queue per workflow. A single minute tick that claims due triggers
 * from the database is simpler, survives restarts, and puts timezone handling
 * in one place we control.
 */
export async function ensureSchedulerTick(): Promise<void> {
  const instance = await getBoss();
  await instance.schedule(QUEUE_SCHEDULER_TICK, '* * * * *', {}, { retryLimit: 0 });
}

export async function stopQueue(): Promise<void> {
  if (!boss) return;
  await boss.stop({ graceful: true, wait: true });
  boss = null;
  starting = null;
}
