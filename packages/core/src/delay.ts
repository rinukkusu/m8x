/**
 * A sleep that gives up when the execution is cancelled.
 *
 * Shared by the runner's retry backoff and the Wait node, because a timer that
 * ignores the abort signal is the thing that keeps a cancelled run alive.
 */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
  });
}
