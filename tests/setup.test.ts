/**
 * Tests: basecampSetupAdapter
 *
 * Validates account ID normalization, input validation,
 * and config application for the setup flow.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (value: string | undefined | null): string => {
    const trimmed = (value ?? "").trim();
    return trimmed || "default";
  },
  applyAccountNameToChannelSection: ({ cfg, channelKey, accountId, name }: any) => {
    const section = cfg.channels?.[channelKey] ?? {};
    const accounts = section.accounts ?? {};
    const acct = accounts[accountId] ?? {};
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        [channelKey]: {
          ...section,
          accounts: {
            ...accounts,
            [accountId]: { ...acct, displayName: name },
          },
        },
      },
    };
  },
}));

import { basecampSetupAdapter } from "../src/adapters/setup.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("basecampSetupAdapter", () => {
  describe("resolveAccountId", () => {
    it("normalizes DEFAULT_ACCOUNT_ID to 'default'", () => {
      expect(basecampSetupAdapter.resolveAccountId({ accountId: "" })).toBe("default");
    });

    it("normalizes undefined to 'default'", () => {
      expect(basecampSetupAdapter.resolveAccountId({ accountId: undefined as any })).toBe("default");
    });

    it("preserves custom account ID", () => {
      expect(basecampSetupAdapter.resolveAccountId({ accountId: "my-team" })).toBe("my-team");
    });

    it("trims whitespace", () => {
      expect(basecampSetupAdapter.resolveAccountId({ accountId: "  team-a  " })).toBe("team-a");
    });
  });

  describe("validateInput", () => {
    it("returns null (no-op)", () => {
      expect(basecampSetupAdapter.validateInput!({} as any)).toBeNull();
    });
  });

  describe("applyAccountConfig", () => {
    const baseCfg = { channels: {} } as any;

    it("applies tokenFile path", () => {
      const result = basecampSetupAdapter.applyAccountConfig({
        cfg: baseCfg,
        accountId: "default",
        input: { name: "Test", tokenFile: "/path/to/token" } as any,
      });

      const acct = result.channels.basecamp.accounts.default;
      expect(acct.tokenFile).toBe("/path/to/token");
      expect(acct.token).toBeUndefined();
      expect(acct.enabled).toBe(true);
    });

    it("applies inline token", () => {
      const result = basecampSetupAdapter.applyAccountConfig({
        cfg: baseCfg,
        accountId: "default",
        input: { name: "Test", token: "my-secret-token" } as any,
      });

      const acct = result.channels.basecamp.accounts.default;
      expect(acct.token).toBe("my-secret-token");
      expect(acct.tokenFile).toBeUndefined();
    });

    it("preserves existing account keys", () => {
      const cfgWithExisting = {
        channels: {
          basecamp: {
            accounts: {
              default: { personId: "42", cliProfile: "main" },
            },
          },
        },
      } as any;

      const result = basecampSetupAdapter.applyAccountConfig({
        cfg: cfgWithExisting,
        accountId: "default",
        input: { name: "Test", tokenFile: "/tok" } as any,
      });

      const acct = result.channels.basecamp.accounts.default;
      expect(acct.personId).toBe("42");
      expect(acct.cliProfile).toBe("main");
      expect(acct.tokenFile).toBe("/tok");
    });

    it("sets channel and account enabled", () => {
      const result = basecampSetupAdapter.applyAccountConfig({
        cfg: baseCfg,
        accountId: "new-acct",
        input: { name: "New" } as any,
      });

      expect(result.channels.basecamp.enabled).toBe(true);
      expect(result.channels.basecamp.accounts["new-acct"].enabled).toBe(true);
    });

    it("applies with no token or tokenFile", () => {
      const result = basecampSetupAdapter.applyAccountConfig({
        cfg: baseCfg,
        accountId: "default",
        input: { name: "Minimal" } as any,
      });

      const acct = result.channels.basecamp.accounts.default;
      expect(acct.token).toBeUndefined();
      expect(acct.tokenFile).toBeUndefined();
      expect(acct.enabled).toBe(true);
    });
  });
});
