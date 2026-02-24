/**
 * Tests: basecampPairingAdapter
 *
 * Validates allowlist entry normalization and approval notification.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (v: string | undefined) => (v ?? "").trim() || "default",
  PAIRING_APPROVED_MESSAGE: "You have been approved!",
}));

const mockClient = {
  raw: {
    GET: vi.fn(),
    POST: vi.fn(),
    PUT: vi.fn(),
    DELETE: vi.fn(),
  },
};

vi.mock("../src/basecamp-client.js", () => ({
  getClient: vi.fn(() => mockClient),
  rawOrThrow: vi.fn(async (result: any) => result?.data),
  numId: (_label: string, value: string | number) => Number(value),
}));

vi.mock("../src/config.js", () => ({
  resolveBasecampAccount: vi.fn(() => ({
    accountId: "default",
    personId: "99",
    token: "tok",
    tokenSource: "config",
    enabled: true,
    config: { personId: "99" },
  })),
}));

import { basecampPairingAdapter } from "../src/adapters/pairing.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("basecampPairingAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("normalizeAllowEntry", () => {
    it("strips 'basecamp:' prefix", () => {
      expect(basecampPairingAdapter.normalizeAllowEntry("basecamp:12345")).toBe("12345");
    });

    it("strips 'BC:' prefix (case-insensitive)", () => {
      expect(basecampPairingAdapter.normalizeAllowEntry("BC:67890")).toBe("67890");
      expect(basecampPairingAdapter.normalizeAllowEntry("bc:67890")).toBe("67890");
    });

    it("strips 'Basecamp:' mixed case", () => {
      expect(basecampPairingAdapter.normalizeAllowEntry("Basecamp:42")).toBe("42");
    });

    it("passes plain numeric ID through", () => {
      expect(basecampPairingAdapter.normalizeAllowEntry("99999")).toBe("99999");
    });

    it("trims whitespace", () => {
      expect(basecampPairingAdapter.normalizeAllowEntry("basecamp:  111 ")).toBe("111");
    });
  });

  describe("notifyApproval", () => {
    it("calls SDK client to post a Ping message", async () => {
      mockClient.raw.POST.mockResolvedValue({
        data: { id: 1 },
        response: { ok: true, headers: new Map() },
      });

      await basecampPairingAdapter.notifyApproval!({
        cfg: {} as any,
        id: "42",
      });

      expect(mockClient.raw.POST).toHaveBeenCalledWith(
        expect.stringContaining("/circles/people/42/lines.json"),
        expect.objectContaining({
          body: expect.objectContaining({
            content: expect.stringContaining("You have been approved!"),
          }),
        }),
      );
    });

    it("swallows errors silently", async () => {
      mockClient.raw.POST.mockRejectedValue(new Error("network error"));

      // Should not throw
      await expect(
        basecampPairingAdapter.notifyApproval!({ cfg: {} as any, id: "42" }),
      ).resolves.toBeUndefined();
    });
  });
});
