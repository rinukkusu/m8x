import 'dotenv/config';

import { prisma, startWorker, stopWorker } from '@m8x/core/server';

/**
 * The worker as its own process.
 *
 * Thin on purpose: the loop itself lives in core so that running it here and
 * running it inside the web server are the same code path. See
 * M8X_RUN_WORKER_IN_WEB for the single-container arrangement.
 */

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.info(`[worker] ${signal} received, finishing in-flight executions`);
  try {
    await stopWorker();
    await prisma.$disconnect();
  } catch (error) {
    console.error('[worker] shutdown was not clean', error);
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

startWorker().catch((error) => {
  console.error('[worker] failed to start', error);
  process.exit(1);
});
