/**
 * Server startup: the first account, and optionally the execution worker.
 *
 * Next calls this once per server process, before handling any request, which
 * puts it after the entrypoint has applied the schema.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Imported lazily so the queue and the database client are not pulled in at
  // all when this process has nothing to do with either.
  const { ensureSeedUser } = await import('@m8x/core/server');

  try {
    await ensureSeedUser((message) => console.info(message));
  } catch (error) {
    // A database that is not reachable yet, or a schema the entrypoint did not
    // apply. Serving the login page and failing there is more useful than
    // refusing to boot, and the next restart tries again.
    console.error('[bootstrap] could not create the first account', error);
  }

  await startWorkerIfRequested();
}

/**
 * Two containers is the default and the better shape for anything real:
 * restarting the app to ship a UI change would otherwise kill every workflow
 * mid-run, and a workflow that exhausts memory would take the UI down with it.
 *
 * For a single team on one box, those costs are often worth avoiding a second
 * container. Setting M8X_RUN_WORKER_IN_WEB=1 starts the same loop the worker
 * process runs, in this process.
 */
async function startWorkerIfRequested(): Promise<void> {
  if (process.env.M8X_RUN_WORKER_IN_WEB !== '1') return;

  const { startWorker, stopWorker } = await import('@m8x/core/server');

  await startWorker({
    log: (message) => console.info(message),
  });

  // Next does not run shutdown hooks for us, so the queue is drained here.
  // Without this a deploy would leave executions stranded in `running`.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`[worker] ${signal} received, draining`);
    void stopWorker().finally(() => process.exit(0));
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
