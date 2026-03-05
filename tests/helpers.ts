/**
 * Shared test helpers for the Basecamp OpenClaw plugin.
 * Provides factory functions for common test fixtures.
 *
 * This file does NOT contain any test code (no describe/it/expect).
 * Import these helpers into test files that need them.
 */
import type { BasecampInboundMessage, BasecampInboundMeta, ResolvedBasecampAccount } from "../src/types.js";

/**
 * Build a minimal OpenClaw config object with optional basecamp section.
 */
export function cfg(basecamp?: Record<string, unknown>): any {
  if (!basecamp) return {} as any;
  return { channels: { basecamp } } as any;
}

/**
 * Build a config with pre-configured accounts.
 */
export function cfgWithAccounts(
  accounts: Record<string, Record<string, unknown>>,
  extra?: Record<string, unknown>,
): any {
  return cfg({ accounts, ...extra });
}

/**
 * Build a default ResolvedBasecampAccount for testing.
 */
export function stubAccount(overrides?: Partial<ResolvedBasecampAccount>): ResolvedBasecampAccount {
  return {
    accountId: "test-acct",
    enabled: true,
    personId: "999",
    token: "tok-test",
    tokenSource: "config",
    config: { personId: "999" },
    ...overrides,
  };
}

/**
 * Build a default BasecampInboundMessage for testing.
 */
export function stubMsg(
  overrides?: Partial<BasecampInboundMessage> & { meta?: Partial<BasecampInboundMeta> },
): BasecampInboundMessage {
  const meta: BasecampInboundMeta = {
    bucketId: "456",
    recordingId: "123",
    recordableType: "Chat::Transcript",
    eventKind: "line_created",
    mentions: [],
    mentionsAgent: false,
    attachments: [],
    sources: ["activity_feed"],
    ...overrides?.meta,
  };

  return {
    channel: "basecamp",
    accountId: "test-acct",
    peer: { kind: "group", id: "recording:123" },
    parentPeer: { kind: "group", id: "bucket:456" },
    sender: { id: "777", name: "Test User" },
    text: "Hello from tests",
    html: "<p>Hello from tests</p>",
    dedupKey: "activity:test-1",
    createdAt: "2025-01-15T10:00:00Z",
    ...overrides,
    meta,
  };
}

/**
 * Standard mock factory for openclaw/plugin-sdk.
 * Use in vi.mock("openclaw/plugin-sdk", () => sdkMock())
 */
export function sdkMock() {
  return {
    DEFAULT_ACCOUNT_ID: "default",
    normalizeAccountId: (value: string | undefined | null): string => {
      const trimmed = (value ?? "").trim();
      return trimmed || "default";
    },
  };
}

/**
 * Standard mock runtime factory for tests that need getBasecampRuntime.
 */
export function stubRuntime(overrides?: Record<string, unknown>) {
  return {
    config: {
      loadConfig: () => ({
        channels: {
          basecamp: {
            accounts: { "test-acct": { personId: "999" } },
          },
        },
      }),
    },
    channel: {
      routing: { resolveAgentRoute: () => null },
      reply: { dispatchReplyWithBufferedBlockDispatcher: async () => {} },
    },
    ...overrides,
  };
}
