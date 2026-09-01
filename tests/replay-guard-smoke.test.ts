/**
 * SPEC §2.14 gate: prove `openclaw/plugin-sdk/persistent-dedupe` works WITHOUT
 * a trusted install. No mocks — this exercises the real SDK module against a
 * temp OPENCLAW_STATE_DIR. If a trust gate ever appears on this path, this
 * test fails and the plugin must fall back to its own store behind the same
 * replay-guard interface.
 *
 * Finding recorded here: the SDK's `createChannelReplayGuard` multi-key claim
 * is "claimed when ANY key is new", which would defeat cross-source collapse
 * (a webhook with a fresh primary key but already-seen secondary key would
 * still process). The plugin guard therefore drives `createClaimableDedupe`
 * per key with all-or-nothing semantics — see src/inbound/replay-guard.ts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { afterAll, describe, expect, it } from "vitest";
import { createBasecampReplayGuard } from "../src/inbound/replay-guard.js";

const stateDir = mkdtempSync(join(tmpdir(), "basecamp-replay-smoke-"));
const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("persistent-dedupe smoke (untrusted install)", () => {
  it("raw SDK claim → commit → hasRecent works against the real store", async () => {
    // NOTE: namespace sizing must stay consistent for a given namespace across
    // instances — the shared plugin-state store rejects (via onDiskError)
    // inconsistent maxEntries for an already-registered namespace. Use a
    // dedicated namespace here so guard-default sizing elsewhere is unaffected.
    const dedupe = createClaimableDedupe({
      pluginId: "basecamp",
      namespacePrefix: "basecamp.event-dedupe",
      ttlMs: 24 * 60 * 60 * 1000,
      memoryMaxSize: 1000,
      stateMaxEntries: 10_000,
      env,
      onDiskError: (err) => {
        throw err;
      },
    });

    expect(await dedupe.hasRecent("smoke:raw", { namespace: "raw" })).toBe(false);
    const claim = await dedupe.claim("smoke:raw", { namespace: "raw" });
    expect(claim.kind).toBe("claimed");
    await dedupe.commit("smoke:raw", { namespace: "raw" });
    expect(await dedupe.hasRecent("smoke:raw", { namespace: "raw" })).toBe(true);
    expect((await dedupe.claim("smoke:raw", { namespace: "raw" })).kind).toBe("duplicate");
  });

  it("guard: claim → process → commit exactly once", async () => {
    const guard = createBasecampReplayGuard({ env });
    const evt = { accountId: "acct", primaryKey: "activity:2" };
    let runs = 0;

    const first = await guard.processGuarded(evt, async () => {
      runs++;
      return "done";
    });
    expect(first).toEqual({ kind: "processed", value: "done" });

    const second = await guard.processGuarded(evt, async () => {
      runs++;
      return "again";
    });
    expect(second.kind).toBe("duplicate");
    expect(runs).toBe(1);
  });

  it("guard: cross-source secondary key collapses events from different sources", async () => {
    const guard = createBasecampReplayGuard({ env });
    const secondaryKey = "77:created:2026-01-01T00:00:00Z";
    const activity = { accountId: "acct", primaryKey: "activity:3", secondaryKey };
    const webhook = { accountId: "acct", primaryKey: "webhook:99", secondaryKey };

    expect((await guard.processGuarded(activity, async () => "a")).kind).toBe("processed");
    expect((await guard.processGuarded(webhook, async () => "b")).kind).toBe("duplicate");
  });

  it("guard: persists across instances (real SQLite state, not process memory)", async () => {
    const first = createBasecampReplayGuard({ env });
    const evt = { accountId: "acct", primaryKey: "activity:4" };
    expect((await first.processGuarded(evt, async () => "x")).kind).toBe("processed");

    // A fresh guard over the same env must see the committed key from disk.
    const second = createBasecampReplayGuard({ env });
    expect(await second.hasRecent(evt)).toBe(true);
    expect((await second.processGuarded(evt, async () => "y")).kind).toBe("duplicate");
  });

  it("guard: failure releases the claim so the event can be retried", async () => {
    const guard = createBasecampReplayGuard({ env });
    const evt = { accountId: "acct", primaryKey: "activity:5", secondaryKey: "5:created:t" };

    await expect(
      guard.processGuarded(evt, async () => {
        throw new Error("dispatch failed");
      }),
    ).rejects.toThrow("dispatch failed");

    expect(await guard.hasRecent(evt)).toBe(false);
    const retry = await guard.processGuarded(evt, async () => "ok");
    expect(retry).toEqual({ kind: "processed", value: "ok" });
  });

  it("guard: namespaces isolate accounts", async () => {
    const guard = createBasecampReplayGuard({ env });
    const a = { accountId: "a", primaryKey: "activity:6" };
    const b = { accountId: "b", primaryKey: "activity:6" };

    expect((await guard.processGuarded(a, async () => 1)).kind).toBe("processed");
    expect((await guard.processGuarded(b, async () => 2)).kind).toBe("processed");
  });
});
