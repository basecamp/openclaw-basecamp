/**
 * Tests: basecampSetupContract (SPEC §2.11)
 *
 * Behavioral tests against the channel-owned setup contract:
 * field metadata, parseInput, resolveAccountId, applyAccountName,
 * and applyAccountConfig.
 */
import { describe, expect, it } from "vitest";

import { basecampSetupContract } from "../src/channel-setup.js";

function cfg(basecamp?: Record<string, unknown>) {
  if (!basecamp) return { channels: {} } as any;
  return { channels: { basecamp } } as any;
}

describe("basecampSetupContract", () => {
  it("is a channel-owned contract", () => {
    expect(basecampSetupContract.kind).toBe("channel-owned");
  });

  describe("metadata.fields", () => {
    it("declares the Basecamp setup fields with CLI flags", () => {
      const keys = basecampSetupContract.metadata.fields.map((f) => f.key);
      expect(keys).toEqual([
        "token",
        "tokenFile",
        "personId",
        "basecampAccountId",
        "oauthClientId",
        "oauthClientSecret",
        "cliProfile",
      ]);
      for (const field of basecampSetupContract.metadata.fields) {
        expect(field.cli.flags, `${field.key} missing flags`).toBeTruthy();
        expect(field.cli.description, `${field.key} missing description`).toBeTruthy();
      }
    });

    it("marks credential fields sensitive", () => {
      const byKey = Object.fromEntries(basecampSetupContract.metadata.fields.map((f) => [f.key, f]));
      expect((byKey.token as { sensitive?: boolean }).sensitive).toBe(true);
      expect((byKey.tokenFile as { sensitive?: boolean }).sensitive).toBe(true);
      expect((byKey.oauthClientSecret as { sensitive?: boolean }).sensitive).toBe(true);
      expect((byKey.personId as { sensitive?: boolean }).sensitive).toBeFalsy();
    });
  });

  describe("parseInput", () => {
    it("accepts a valid input envelope", () => {
      const result = basecampSetupContract.parseInput({
        name: "Bot",
        token: "tok",
        personId: "42",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toMatchObject({ name: "Bot", token: "tok", personId: "42" });
      }
    });

    it("accepts an empty envelope", () => {
      expect(basecampSetupContract.parseInput({}).ok).toBe(true);
    });

    it("rejects wrongly-typed field values", () => {
      const result = basecampSetupContract.parseInput({ token: 42 });
      expect(result.ok).toBe(false);
    });
  });

  describe("resolveAccountId", () => {
    it("normalizes empty input to 'default'", () => {
      expect(basecampSetupContract.resolveAccountId!({ cfg: cfg(), accountId: "" })).toBe("default");
    });

    it("normalizes undefined to 'default'", () => {
      expect(basecampSetupContract.resolveAccountId!({ cfg: cfg() })).toBe("default");
    });

    it("preserves custom account ID and trims whitespace", () => {
      expect(basecampSetupContract.resolveAccountId!({ cfg: cfg(), accountId: "  team-a  " })).toBe("team-a");
    });
  });

  describe("applyAccountName", () => {
    it("applies name to the channel section", () => {
      const result = basecampSetupContract.applyAccountName!({
        cfg: cfg({ accounts: { default: { personId: "1" } } }),
        accountId: "default",
        name: "Bot",
      });
      expect((result.channels as any).basecamp.accounts.default.name).toBe("Bot");
    });

    it("does nothing when name is empty", () => {
      const input = cfg({ accounts: { default: { personId: "1" } } });
      const result = basecampSetupContract.applyAccountName!({ cfg: input, accountId: "default", name: "" });
      expect(result).toBe(input);
    });
  });

  describe("applyAccountConfig", () => {
    it("applies tokenFile path", () => {
      const result = basecampSetupContract.applyAccountConfig({
        cfg: cfg(),
        accountId: "default",
        input: { name: "Test", tokenFile: "/path/to/token" },
      });

      const acct = (result.channels as any).basecamp.accounts.default;
      expect(acct.tokenFile).toBe("/path/to/token");
      expect(acct.token).toBeUndefined();
      expect(acct.enabled).toBe(true);
    });

    it("applies inline token", () => {
      const result = basecampSetupContract.applyAccountConfig({
        cfg: cfg(),
        accountId: "default",
        input: { name: "Test", token: "my-secret-token" },
      });

      const acct = (result.channels as any).basecamp.accounts.default;
      expect(acct.token).toBe("my-secret-token");
      expect(acct.tokenFile).toBeUndefined();
    });

    it("prefers tokenFile over token when both are given", () => {
      const result = basecampSetupContract.applyAccountConfig({
        cfg: cfg(),
        accountId: "default",
        input: { token: "tok", tokenFile: "/tok" },
      });

      const acct = (result.channels as any).basecamp.accounts.default;
      expect(acct.tokenFile).toBe("/tok");
      expect(acct.token).toBeUndefined();
    });

    it("applies identity and OAuth fields", () => {
      const result = basecampSetupContract.applyAccountConfig({
        cfg: cfg(),
        accountId: "work",
        input: {
          personId: "42",
          basecampAccountId: "99999",
          oauthClientId: "aabbccdd00112233445566778899aabbccddeeff",
          oauthClientSecret: "shh",
          cliProfile: "prod",
        },
      });

      const acct = (result.channels as any).basecamp.accounts.work;
      expect(acct.personId).toBe("42");
      expect(acct.basecampAccountId).toBe("99999");
      expect(acct.oauthClientId).toBe("aabbccdd00112233445566778899aabbccddeeff");
      expect(acct.oauthClientSecret).toBe("shh");
      expect(acct.cliProfile).toBe("prod");
    });

    it("preserves existing account keys", () => {
      const cfgWithExisting = cfg({
        accounts: {
          default: { personId: "42", cliProfile: "main" },
        },
      });

      const result = basecampSetupContract.applyAccountConfig({
        cfg: cfgWithExisting,
        accountId: "default",
        input: { name: "Test", tokenFile: "/tok" },
      });

      const acct = (result.channels as any).basecamp.accounts.default;
      expect(acct.personId).toBe("42");
      expect(acct.cliProfile).toBe("main");
      expect(acct.tokenFile).toBe("/tok");
    });

    it("sets channel and account enabled", () => {
      const result = basecampSetupContract.applyAccountConfig({
        cfg: cfg(),
        accountId: "new-acct",
        input: { name: "New" },
      });

      expect((result.channels as any).basecamp.enabled).toBe(true);
      expect((result.channels as any).basecamp.accounts["new-acct"].enabled).toBe(true);
    });

    it("applies with no token or tokenFile", () => {
      const result = basecampSetupContract.applyAccountConfig({
        cfg: cfg(),
        accountId: "default",
        input: { name: "Minimal" },
      });

      const acct = (result.channels as any).basecamp.accounts.default;
      expect(acct.token).toBeUndefined();
      expect(acct.tokenFile).toBeUndefined();
      expect(acct.enabled).toBe(true);
    });
  });
});
