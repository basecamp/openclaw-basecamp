/**
 * Structured logging for the Basecamp channel plugin.
 *
 * Wraps the SDK log object (or console) with a consistent prefix format:
 *   [basecamp:${source}:${accountId}] ${event} ${JSON.stringify(detail)}
 */

export interface StructuredLog {
  info(event: string, detail?: Record<string, unknown>): void;
  warn(event: string, detail?: Record<string, unknown>): void;
  error(event: string, detail?: Record<string, unknown>): void;
  debug(event: string, detail?: Record<string, unknown>): void;
}

export type SdkLog = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
};

function formatMessage(prefix: string, event: string, detail?: Record<string, unknown>): string {
  return detail ? `${prefix} ${event} ${JSON.stringify(detail)}` : `${prefix} ${event}`;
}

/**
 * Create a structured logger that delegates to the SDK log object.
 * If sdkLog is undefined, all calls are no-ops.
 */
export function createStructuredLog(
  sdkLog: SdkLog | undefined,
  context: { accountId: string; source: string },
): StructuredLog {
  const prefix = `[basecamp:${context.source}:${context.accountId}]`;
  return {
    info(event, detail) {
      sdkLog?.info(formatMessage(prefix, event, detail));
    },
    warn(event, detail) {
      sdkLog?.warn(formatMessage(prefix, event, detail));
    },
    error(event, detail) {
      sdkLog?.error(formatMessage(prefix, event, detail));
    },
    debug(event, detail) {
      sdkLog?.debug?.(formatMessage(prefix, event, detail));
    },
  };
}

/**
 * Create a structured logger that delegates to console methods.
 * Useful in contexts where the SDK log object is not available (e.g. webhook handlers).
 */
export function createConsoleStructuredLog(context: { accountId: string; source: string }): StructuredLog {
  const prefix = `[basecamp:${context.source}:${context.accountId}]`;
  return {
    info(event, detail) {
      console.info(formatMessage(prefix, event, detail));
    },
    warn(event, detail) {
      console.warn(formatMessage(prefix, event, detail));
    },
    error(event, detail) {
      console.error(formatMessage(prefix, event, detail));
    },
    debug(event, detail) {
      console.debug(formatMessage(prefix, event, detail));
    },
  };
}
