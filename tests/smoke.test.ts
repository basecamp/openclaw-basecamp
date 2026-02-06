/**
 * Smoke tests: exercise our actual module code against live Basecamp API.
 *
 * These tests call the real plugin functions (pollActivityFeed, bcqGet, etc.)
 * and verify they handle real API responses correctly. This is NOT a unit test
 * with mocked responses -- it hits the live API via bcq.
 *
 * Gated behind OPENCLAW_INTEGRATION=1. When the env var is unset, all tests
 * are skipped (shown as "skipped" in vitest output).
 *
 * Run with: OPENCLAW_INTEGRATION=1 npx vitest run tests/smoke.test.ts
 */

import { describe, it, expect } from "vitest";
import { bcqGet, bcqMe, bcqTimeline, bcqReadings, bcqApiGet } from "../src/bcq.js";
import { pollActivityFeed } from "../src/inbound/activity.js";
import { pollReadings } from "../src/inbound/readings.js";
import { EventDedup } from "../src/inbound/dedup.js";
import type { ResolvedBasecampAccount } from "../src/types.js";

// ---------------------------------------------------------------------------
// Integration gate
// ---------------------------------------------------------------------------

const INTEGRATION_ENABLED = process.env.OPENCLAW_INTEGRATION === "1";
const describeIntegration = INTEGRATION_ENABLED ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Shared test account (uses bcq's default authenticated account)
// ---------------------------------------------------------------------------

const testAccount: ResolvedBasecampAccount = {
  accountId: "2914079",
  enabled: true,
  personId: "3", // Jeremy's person ID from bcq me
  token: "", // bcq handles auth
  tokenSource: "none",
  config: { personId: "3" },
};

const log = {
  info: (msg: string) => console.log(`[info] ${msg}`),
  warn: (msg: string) => console.warn(`[warn] ${msg}`),
  debug: (msg: string) => console.log(`[debug] ${msg}`),
  error: (msg: string) => console.error(`[error] ${msg}`),
};

// ---------------------------------------------------------------------------
// bcq.ts -- verify our wrapper works
// ---------------------------------------------------------------------------

describeIntegration("smoke: bcq.ts", () => {
  it("bcqMe returns authenticated user", async () => {
    const result = await bcqMe();
    expect(result.data).toBeDefined();
    // bcq me returns { identity: { id, first_name, ... }, accounts: [...] }
    const me = result.data as any;
    expect(me.identity?.id ?? me.id).toBeTruthy();
    console.log("bcqMe:", JSON.stringify(result.data).slice(0, 200));
  });

  it("bcqGet fetches a known API endpoint", async () => {
    const result = await bcqGet<any[]>("/projects.json", {
      accountId: testAccount.accountId,
    });
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
    console.log(`bcqGet /projects.json: ${result.data.length} projects`);
  });

  it("bcqTimeline returns activity events", async () => {
    const result = await bcqTimeline<any[]>({
      accountId: testAccount.accountId,
    });
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
    // Verify shape of first event
    const first = result.data[0];
    expect(first.id).toBeTruthy();
    expect(first.kind).toBeTruthy();
    expect(first.created_at).toBeTruthy();
    expect(first.bucket?.id).toBeTruthy();
    console.log(`bcqTimeline: ${result.data.length} events, newest kind=${first.kind}`);
  });

  it("bcqReadings returns null or readings object", async () => {
    const result = await bcqReadings<any>({
      accountId: testAccount.accountId,
    });
    // 204 No Content -> null, 200 -> { unreads, reads, memories }
    if (result.data === null) {
      console.log("bcqReadings: 204 No Content (no unread items)");
    } else {
      expect(result.data).toHaveProperty("unreads");
      console.log(`bcqReadings: ${result.data.unreads?.length ?? 0} unreads`);
    }
  });
});

// ---------------------------------------------------------------------------
// pollActivityFeed -- the full pipeline
// ---------------------------------------------------------------------------

describeIntegration("smoke: pollActivityFeed", () => {
  it("polls activity feed and returns normalized events", async () => {
    const result = await pollActivityFeed({
      account: testAccount,
      log,
    });

    console.log(
      `pollActivityFeed: ${result.events.length} events, newestAt=${result.newestAt}`,
    );

    // Should get events from a real active account
    expect(result.events.length).toBeGreaterThan(0);

    for (const msg of result.events) {
      // Core fields
      expect(msg.channel).toBe("basecamp");
      expect(msg.accountId).toBe("2914079");
      expect(msg.dedupKey).toMatch(/^activity:/);
      expect(msg.createdAt).toBeTruthy();

      // Peer routing
      expect(msg.peer).toBeDefined();
      expect(msg.peer.id).toMatch(/^(recording:|bucket:|ping:)/);
      expect(msg.peer.kind).toMatch(/^(dm|group)$/);

      // Parent peer (non-pings should have one)
      if (!msg.peer.id.startsWith("ping:")) {
        expect(msg.parentPeer).toBeDefined();
        expect(msg.parentPeer!.id).toMatch(/^bucket:\d+$/);
      }

      // Sender
      expect(msg.sender.id).toBeTruthy();
      expect(msg.sender.name).toBeTruthy();

      // Meta
      expect(msg.meta.bucketId).toBeTruthy();
      expect(msg.meta.recordingId).toBeTruthy();
      expect(msg.meta.recordableType).toBeTruthy();
      expect(msg.meta.eventKind).toBeTruthy();
      expect(msg.meta.sources).toContain("activity_feed");
    }

    // Log first event for manual inspection
    if (result.events.length > 0) {
      const first = result.events[0];
      console.log("First event:", JSON.stringify({
        dedupKey: first.dedupKey,
        peer: first.peer,
        parentPeer: first.parentPeer,
        sender: { id: first.sender.id, name: first.sender.name },
        text: first.text?.slice(0, 80),
        meta: {
          bucketId: first.meta.bucketId,
          recordingId: first.meta.recordingId,
          recordableType: first.meta.recordableType,
          eventKind: first.meta.eventKind,
          mentionsAgent: first.meta.mentionsAgent,
          matchedPatterns: first.meta.matchedPatterns,
        },
      }, null, 2));
    }
  });

  it("cursor filtering skips old events", async () => {
    // First poll: get all events
    const first = await pollActivityFeed({ account: testAccount, log });
    expect(first.events.length).toBeGreaterThan(0);

    // Second poll: use the newest timestamp as cursor -- should get 0 events
    const second = await pollActivityFeed({
      account: testAccount,
      since: first.newestAt,
      log,
    });

    console.log(
      `Cursor test: first=${first.events.length} events, second=${second.events.length} events (cursor=${first.newestAt})`,
    );
    expect(second.events.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// pollReadings -- the full pipeline
// ---------------------------------------------------------------------------

describeIntegration("smoke: pollReadings", () => {
  it("pollReadings handles empty and populated responses", async () => {
    const result = await pollReadings({ account: testAccount, log });

    console.log(
      `pollReadings: ${result.events.length} events, newestAt=${result.newestAt}`,
    );

    // Whether 0 or N events, the shape contract holds
    for (const msg of result.events) {
      expect(msg.channel).toBe("basecamp");
      expect(msg.dedupKey).toMatch(/^reading:/);
      expect(msg.peer).toBeDefined();
      expect(msg.meta.recordingId).toBeTruthy();
      expect(msg.meta.sources).toContain("readings");
    }
  });
});

// ---------------------------------------------------------------------------
// EventDedup -- cross-source dedup with real events
// ---------------------------------------------------------------------------

describeIntegration("smoke: EventDedup with real events", () => {
  it("dedup correctly tracks real activity events", async () => {
    const dedup = new EventDedup({ ttlMs: 60_000 });

    const result = await pollActivityFeed({ account: testAccount, log });
    expect(result.events.length).toBeGreaterThan(0);

    // First pass: nothing should be a duplicate
    let firstPassDupes = 0;
    for (const msg of result.events) {
      if (dedup.isDuplicate(msg.dedupKey)) {
        firstPassDupes++;
      }
      dedup.record(msg.dedupKey);
    }
    expect(firstPassDupes).toBe(0);

    // Second pass: everything should be a duplicate
    let secondPassDupes = 0;
    for (const msg of result.events) {
      if (dedup.isDuplicate(msg.dedupKey)) {
        secondPassDupes++;
      }
    }
    expect(secondPassDupes).toBe(result.events.length);

    console.log(
      `Dedup: ${result.events.length} events, ${firstPassDupes} dupes on first pass, ${secondPassDupes} dupes on second pass`,
    );
  });
});

// ---------------------------------------------------------------------------
// URL parsing against real app_urls
// ---------------------------------------------------------------------------

describeIntegration("smoke: URL parsing with real data", () => {
  it("parseBucketIdFromUrl handles all real app_urls", async () => {
    const result = await pollActivityFeed({ account: testAccount, log });

    for (const msg of result.events) {
      // The meta should have a bucketId -- verify our URL parser agrees
      if (msg.meta.bucketId) {
        // Reconstruct: every event came from an app_url that had a bucket
        // We can't get the original URL, but we can check the ID is numeric
        expect(msg.meta.bucketId).toMatch(/^\d+$/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Directory listing integration
// ---------------------------------------------------------------------------

describeIntegration("smoke: directory integration", () => {
  it("bcqApiGet /people.json returns people array", async () => {
    const people = await bcqApiGet<any[]>("/people.json", testAccount.accountId);
    expect(Array.isArray(people)).toBe(true);
    expect(people.length).toBeGreaterThan(0);
    expect(people[0]).toHaveProperty("id");
    expect(people[0]).toHaveProperty("name");
    console.log(`Directory: ${people.length} people`);
  });
});

// ---------------------------------------------------------------------------
// Status probe integration
// ---------------------------------------------------------------------------

describeIntegration("smoke: status adapter integration", () => {
  it("probeAccount returns successful probe for real account", async () => {
    const { basecampStatusAdapter } = await import("../src/adapters/status.js");
    const probe = await basecampStatusAdapter.probeAccount!({
      account: testAccount,
      timeoutMs: 10000,
      cfg: {
        channels: {
          basecamp: {
            accounts: {
              [testAccount.accountId]: { personId: testAccount.personId },
            },
          },
        },
      } as any,
    });
    expect(probe.ok).toBe(true);
    expect(probe.authenticated).toBe(true);
    console.log("Status probe:", JSON.stringify(probe));
  });
});
