import 'dotenv/config';

import {
  QUEUE_EXECUTE,
  QUEUE_SCHEDULER_TICK,
  claimDueSchedules,
  createExecution,
  ensureSchedulerTick,
  getBoss,
  prisma,
  stopQueue,
  type ExecuteJob,
} from '@m8x/core/server';

import { executeQueued } from './execute.js';

/**
 * The worker.
 *
 * Executions run here rather than in the web app because a workflow can run for
 * minutes, retry with backoff, and hold an open HTTP connection. A request
 * handler is the wrong shape for all three.
 */

const CONCURRENCY = Number(process.env.M8X_WORKER_CONCURRENCY ?? 5);

async function main(): Promise<void> {
  const boss = await getBoss();

  await boss.work<ExecuteJob>(
    QUEUE_EXECUTE,
    { batchSize: CONCURRENCY },
    async (jobs) => {
      // pg-boss hands over a batch. Running them in parallel is the point of
      // the batch; one slow HTTP call should not hold up four other workflows.
      await Promise.all(jobs.map((job) => executeQueued(job.data.executionId)));
    },
  );

  await boss.work(QUEUE_SCHEDULER_TICK, async () => {
    await tickScheduler();
  });

  await ensureSchedulerTick();

  console.info(`[worker] ready, ${CONCURRENCY} executions at a time`);
}

/**
 * Fire every schedule that has come due.
 *
 * Claiming happens in the database with a conditional update, so running two
 * workers does not double-fire a schedule.
 */
async function tickScheduler(): Promise<void> {
  const due = await claimDueSchedules();
  if (due.length === 0) return;

  for (const trigger of due) {
    try {
      const workflow = await prisma.workflow.findUnique({
        where: { id: trigger.workflowId },
        select: { active: true },
      });

      // A workflow deactivated between the claim and now should not run.
      if (!workflow?.active) continue;

      const { executionId } = await createExecution({
        workflowId: trigger.workflowId,
        trigger: 'schedule',
        input: [{ json: { triggeredAt: new Date().toISOString() } }],
      });

      console.info(`[scheduler] queued ${executionId} for workflow ${trigger.workflowId}`);
    } catch (error) {
      // One broken workflow must not stop the others from being scheduled.
      console.error(`[scheduler] could not queue workflow ${trigger.workflowId}`, error);
    }
  }
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.info(`[worker] ${signal} received, finishing in-flight executions`);
  try {
    // Graceful stop lets running jobs complete rather than leaving executions
    // stranded in `running` for the next boot to clean up.
    await stopQueue();
    await prisma.$disconnect();
  } catch (error) {
    console.error('[worker] shutdown was not clean', error);
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch((error) => {
  console.error('[worker] failed to start', error);
  process.exit(1);
});
