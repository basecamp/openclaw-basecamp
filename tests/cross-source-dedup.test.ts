import { describe, expect, it, vi } from "vitest";
import { EventDedup } from "../src/inbound/dedup.js";

// Mock external deps used by normalize.ts
vi.mock("../src/metrics.js", () => ({
  recordUnknownKind: vi.fn(),
}));
vi.mock("../src/outbound/send.js", () => ({
  resolveCircleInfoCached: vi.fn(() => undefined),
}));

import { normalizeActivityEvent, normalizeWebhookPayload } from "../src/inbound/normalize.js";
import type { BasecampActivityEvent, BasecampWebhookPayload, ResolvedBasecampAccount } from "../src/types.js";

const account: ResolvedBasecampAccount = {
  accountId: "test",
  enabled: true,
  personId: "999",
  token: "t",
  tokenSource: "config",
  config: { personId: "999" },
};

describe("cross-source dedup key parity", () => {
  it("activity and webhook normalizers produce matching secondary key components", async () => {
    // Same underlying BC3 event: comment 300 created in bucket 100 at a known timestamp.
    const kind = "comment_created";
    const createdAt = "2025-06-15T14:30:00Z";
    const recordingId = 300;
    const bucketId = 100;
    const creatorId = 42;

    const activityRaw: BasecampActivityEvent = {
      id: 1001,
      kind,
      action: "created",
      created_at: createdAt,
      bucket: { id: bucketId, name: "Project" },
      creator: { id: creatorId, name: "Alice", email_address: "a@x.co" },
      recording: { id: recordingId, type: "Comment", title: "Hello" },
    };

    const webhookRaw: BasecampWebhookPayload = {
      id: 2001,
      kind,
      created_at: createdAt,
      recording: {
        id: recordingId,
        type: "Comment",
        title: "Hello",
        content: "<p>Hello</p>",
        bucket: { id: bucketId, name: "Project" },
      },
      creator: { id: creatorId, name: "Alice", email_address: "a@x.co" },
    };

    const activityMsg = await normalizeActivityEvent(activityRaw, account);
    const webhookMsg = await normalizeWebhookPayload(webhookRaw, account);

    expect(activityMsg).not.toBeNull();
    expect(webhookMsg).not.toBeNull();

    // Both normalizers must produce the same three secondary-key fields:
    // 1. meta.recordingId — derived from raw recording data
    expect(activityMsg!.meta.recordingId).toBe(webhookMsg!.meta.recordingId);
    expect(activityMsg!.meta.recordingId).toBe(String(recordingId));

    // 2. meta.eventKind — derived from resolveEventKind(raw.kind)
    expect(activityMsg!.meta.eventKind).toBe(webhookMsg!.meta.eventKind);

    // 3. createdAt — both use raw.created_at
    expect(activityMsg!.createdAt).toBe(webhookMsg!.createdAt);
    expect(activityMsg!.createdAt).toBe(createdAt);

    // Therefore, the secondary keys are identical:
    const activitySecondary = EventDedup.secondaryKey(
      activityMsg!.meta.recordingId!,
      activityMsg!.meta.eventKind,
      activityMsg!.createdAt,
    );
    const webhookSecondary = EventDedup.secondaryKey(
      webhookMsg!.meta.recordingId!,
      webhookMsg!.meta.eventKind,
      webhookMsg!.createdAt,
    );
    expect(activitySecondary).toBe(webhookSecondary);

    // Primary keys must differ (different source prefix)
    expect(activityMsg!.dedupKey).not.toBe(webhookMsg!.dedupKey);
    expect(activityMsg!.dedupKey).toMatch(/^activity:/);
    expect(webhookMsg!.dedupKey).toMatch(/^webhook:/);
  });

  it("readings secondary key diverges when unread_at differs from created_at", () => {
    // Readings use unread_at ?? created_at (see normalize.ts:522). In BC3,
    // unread_at is rewritten on unread transitions (Reading#mark_unread!),
    // so cross-source parity with webhooks is best-effort, not guaranteed.
    const recordingId = "456";
    const eventKind = "created";
    const readingsCreatedAt = "2025-06-15T15:00:00Z"; // unread_at, shifted
    const webhookCreatedAt = "2025-06-15T14:30:00Z"; // created_at, original

    const readingsSecondary = EventDedup.secondaryKey(recordingId, eventKind, readingsCreatedAt);
    const webhookSecondary = EventDedup.secondaryKey(recordingId, eventKind, webhookCreatedAt);

    expect(readingsSecondary).not.toBe(webhookSecondary);
  });
});
