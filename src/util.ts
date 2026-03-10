// ---------------------------------------------------------------------------
// HTML helpers — shared by mentions/parse.ts and outbound/format.ts
// ---------------------------------------------------------------------------

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};
const ENTITY_RE = /&(?:amp|lt|gt|quot|nbsp|#39);/g;

/** Decode HTML entities in a single pass (no double-unescaping). */
export function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, (m) => ENTITY_MAP[m] ?? m);
}

/** Strip HTML tags, iterating until no nested tags remain. */
export function stripTags(text: string): string {
  let prev: string;
  do {
    prev = text;
    text = text.replace(/<[^>]+>/g, "");
  } while (text !== prev);
  return text;
}

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
