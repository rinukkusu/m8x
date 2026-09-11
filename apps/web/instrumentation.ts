/**
 * Optionally run the execution worker inside the web server.
 *
 * Two containers is the default and the better shape for anything real:
 * restarting the app to ship a UI change would otherwise kill every workflow
 * mid-run, and a workflow that exhausts memory would take the UI down with it.
 *
 * For a single team on one box, those costs are often worth avoiding a second
 * container. Setting M8X_RUN_WORKER_IN_WEB=1 starts the same loop the worker
 * process runs, in this process.
 *
 * Next calls this once per server process, before handling any request.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.M8X_RUN_WORKER_IN_WEB !== '1') return;

  // Imported lazily so the queue and the database client are not pulled in at
  // all when the worker runs separately, which is the common case.
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
