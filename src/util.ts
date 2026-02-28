/**
 * Race a promise against a timeout. Returns the promise result or undefined on timeout.
 *
 * Note: this only stops *awaiting* the promise — it does not cancel the underlying
 * operation (e.g. a CLI child process). Node will keep the process alive until
 * the child exits. This is acceptable for shutdown: the OS will reap orphaned
 * CLI processes, and a stuck child is better than blocking shutdown indefinitely.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  log?: { warn: (msg: string) => void },
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      log?.warn(`[basecamp] ${label} timed out after ${ms}ms`);
      resolve(undefined);
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
