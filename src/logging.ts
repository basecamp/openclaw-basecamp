/**
 * Structured logging for the Basecamp channel plugin.
 *
 * Wraps the SDK log object (or the OpenClaw runtime logger) with a
 * consistent prefix format:
 *   [basecamp:${source}:${accountId}] ${event} ${JSON.stringify(detail)}
 *
 * When the plugin runtime is available, loggers route through
 * `runtime.logging.getChildLogger` so output participates in the host's
 * redaction and verbosity handling (SPEC §2.26). Console is the fallback
 * for contexts that run before the runtime store is initialized.
 */

import { tryGetBasecampRuntime } from "./runtime.js";

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

/** Shape of the runtime child logger (subset of the SDK RuntimeLogger). */
export type RuntimeChildLogger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

/**
 * Resolve a child logger from the OpenClaw runtime, when initialized.
 * Returns undefined outside a full runtime (unit tests, early startup).
 */
export function getRuntimeLogger(bindings: Record<string, unknown> = {}): RuntimeChildLogger | undefined {
  const runtime = tryGetBasecampRuntime() as
    | { logging?: { getChildLogger?: (bindings?: Record<string, unknown>) => RuntimeChildLogger } }
    | undefined;
  return runtime?.logging?.getChildLogger?.({ plugin: "basecamp", ...bindings });
}

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
 * Create a structured logger for contexts without an SDK log object
 * (e.g. webhook handlers). Routes through the runtime child logger when the
 * plugin runtime is initialized; falls back to console otherwise.
 */
export function createConsoleStructuredLog(context: { accountId: string; source: string }): StructuredLog {
  const prefix = `[basecamp:${context.source}:${context.accountId}]`;
  const logger = getRuntimeLogger({ source: context.source, accountId: context.accountId });
  if (logger) {
    return {
      info(event, detail) {
        logger.info(formatMessage(prefix, event, detail));
      },
      warn(event, detail) {
        logger.warn(formatMessage(prefix, event, detail));
      },
      error(event, detail) {
        logger.error(formatMessage(prefix, event, detail));
      },
      debug(event, detail) {
        logger.debug?.(formatMessage(prefix, event, detail));
      },
    };
  }
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
