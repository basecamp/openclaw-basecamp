import { describe, it, expect, vi } from "vitest";

// Mock external deps used by normalize.ts
vi.mock("../src/metrics.js", () => ({
  recordUnknownKind: vi.fn(),
}));
vi.mock("../src/outbound/send.js", () => ({
  resolveCircleInfoCached: vi.fn(() => undefined),
}));

import {
  normalizeActivityEvent,
  normalizeReadingsEvent,
  normalizeWebhookPayload,
  parseBucketIdFromUrl,
  parseRecordingIdFromIdentifier,
  resolveBasecampPeer,
  resolveParentPeer,
  isSelfMessage,
} from "../src/inbound/normalize.js";
import type {
  BasecampActivityEvent,
  BasecampReadingsEntry,
  BasecampWebhookPayload,
  ResolvedBasecampAccount,
  BasecampPeer,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// Shared mock account
// ---------------------------------------------------------------------------

const mockAccount: ResolvedBasecampAccount = {
  accountId: "test-acct",
  enabled: true,
  personId: "999",
  attachableSgid: "sgid://bc3/Person/999",
  token: "test-token",
  tokenSource: "config",
  config: { personId: "999" },
};

// ---------------------------------------------------------------------------
// Minimal fixture builders
// ---------------------------------------------------------------------------

function makeActivityEvent(overrides: Partial<BasecampActivityEvent> = {}): BasecampActivityEvent {
  return {
    id: 1,
    kind: "comment_created",
    action: "created",
    created_at: "2025-01-15T10:00:00Z",
    bucket: { id: 100, name: "Test Project" },
    creator: { id: 42, name: "Alice", email_address: "alice@example.com", avatar_url: "https://example.com/alice.png" },
    recording: { id: 200, type: "Comment", title: "A comment" },
    ...overrides,
  };
}

function makeReadingsEntry(overrides: Partial<BasecampReadingsEntry> = {}): BasecampReadingsEntry {
  return {
    id: 500,
    created_at: "2025-01-15T12:00:00Z",
    type: "Card",
    title: "Test Card",
    app_url: "https://3.basecamp.com/buckets/100/cards/500",
    creator: { id: 42, name: "Alice", email_address: "alice@example.com" },
    ...overrides,
  };
}

function makeWebhookPayload(overrides: Partial<BasecampWebhookPayload> = {}): BasecampWebhookPayload {
  return {
    id: 900,
    kind: "comment_created",
    created_at: "2025-01-15T14:00:00Z",
    recording: {
      id: 300,
      type: "Comment",
      title: "Webhook comment",
      content: "<p>Hello from webhook</p>",
      bucket: { id: 100, name: "Test Project" },
    },
    creator: { id: 42, name: "Alice", email_address: "alice@example.com" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseBucketIdFromUrl
// ---------------------------------------------------------------------------

describe("parseBucketIdFromUrl", () => {
  it("extracts bucket ID from a relative URL", () => {
    expect(parseBucketIdFromUrl("/buckets/123/messages/456")).toBe("123");
  });

  it("extracts bucket ID from an absolute Basecamp URL", () => {
    expect(parseBucketIdFromUrl("https://3.basecamp.com/buckets/999/cards/111")).toBe("999");
  });

  it("returns undefined when no bucket segment exists", () => {
    expect(parseBucketIdFromUrl("/no-bucket")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseBucketIdFromUrl("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseRecordingIdFromIdentifier
// ---------------------------------------------------------------------------

describe("parseRecordingIdFromIdentifier", () => {
  it("extracts recording ID from Type/ID format", () => {
    expect(parseRecordingIdFromIdentifier("Comment/12345")).toBe("12345");
  });

  it("returns undefined when no slash-number suffix exists", () => {
    expect(parseRecordingIdFromIdentifier("noId")).toBeUndefined();
  });

  it("extracts the last numeric segment", () => {
    expect(parseRecordingIdFromIdentifier("Nested/Path/67890")).toBe("67890");
  });
});

// ---------------------------------------------------------------------------
// resolveBasecampPeer
// ---------------------------------------------------------------------------

describe("resolveBasecampPeer", () => {
  it("Chat::Line with parentRecordingId resolves to recording:<parentRecordingId>", () => {
    const peer = resolveBasecampPeer({
      recordableType: "Chat::Line",
      recordingId: "10",
      parentRecordingId: "5",
      bucketId: "100",
    });
    expect(peer).toEqual({ kind: "group", id: "recording:5" });
  });

  it("Comment with parentRecordingId resolves to recording:<parentRecordingId>", () => {
    const peer = resolveBasecampPeer({
      recordableType: "Comment",
      recordingId: "20",
      parentRecordingId: "15",
      bucketId: "100",
    });
    expect(peer).toEqual({ kind: "group", id: "recording:15" });
  });

  it("Chat::Transcript resolves to recording:<recordingId>", () => {
    const peer = resolveBasecampPeer({
      recordableType: "Chat::Transcript",
      recordingId: "30",
      bucketId: "100",
    });
    expect(peer).toEqual({ kind: "group", id: "recording:30" });
  });

  it("Kanban::Card resolves to recording:<recordingId>", () => {
    const peer = resolveBasecampPeer({
      recordableType: "Kanban::Card",
      recordingId: "40",
      bucketId: "100",
    });
    expect(peer).toEqual({ kind: "group", id: "recording:40" });
  });

  it("Ping with <= 2 participants resolves to dm, ping:<bucketId>", () => {
    const peer = resolveBasecampPeer({
      recordableType: "Chat::Transcript",
      recordingId: "50",
      bucketId: "200",
      isPing: true,
      participantCount: 2,
    });
    expect(peer).toEqual({ kind: "dm", id: "ping:200" });
  });

  it("Ping with > 2 participants resolves to group, ping:<bucketId>", () => {
    const peer = resolveBasecampPeer({
      recordableType: "Chat::Transcript",
      recordingId: "50",
      bucketId: "200",
      isPing: true,
      participantCount: 5,
    });
    expect(peer).toEqual({ kind: "group", id: "ping:200" });
  });

  it("Ping with 0 participants defaults to dm (fail-closed)", () => {
    const peer = resolveBasecampPeer({
      recordableType: "Chat::Transcript",
      recordingId: "50",
      bucketId: "200",
      isPing: true,
      participantCount: 0,
    });
    expect(peer).toEqual({ kind: "dm", id: "ping:200" });
  });

  it("Ping with undefined participants defaults to dm (fail-closed)", () => {
    const peer = resolveBasecampPeer({
      recordableType: "Chat::Transcript",
      recordingId: "50",
      bucketId: "200",
      isPing: true,
      participantCount: undefined,
    });
    expect(peer).toEqual({ kind: "dm", id: "ping:200" });
  });

  it("Chat::Line without parentRecordingId falls back to recording:<recordingId>", () => {
    const peer = resolveBasecampPeer({
      recordableType: "Chat::Line",
      recordingId: "60",
      bucketId: "100",
    });
    expect(peer).toEqual({ kind: "group", id: "recording:60" });
  });
});

// ---------------------------------------------------------------------------
// resolveParentPeer
// ---------------------------------------------------------------------------

describe("resolveParentPeer", () => {
  it("returns bucket:<bucketId> for non-ping", () => {
    const peer = resolveParentPeer("100", false);
    expect(peer).toEqual({ kind: "group", id: "bucket:100" });
  });

  it("returns undefined for ping", () => {
    const peer = resolveParentPeer("100", true);
    expect(peer).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isSelfMessage
// ---------------------------------------------------------------------------

describe("isSelfMessage", () => {
  it("returns true when creatorId matches account personId", () => {
    expect(isSelfMessage("999", mockAccount)).toBe(true);
  });

  it("returns false when creatorId differs from account personId", () => {
    expect(isSelfMessage("123", mockAccount)).toBe(false);
  });

  it("handles numeric creatorId matching string personId", () => {
    expect(isSelfMessage(999, mockAccount)).toBe(true);
  });

  it("handles numeric creatorId not matching", () => {
    expect(isSelfMessage(888, mockAccount)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeActivityEvent
// ---------------------------------------------------------------------------

describe("normalizeActivityEvent", () => {
  it("comment_created maps to recordableType Comment and eventKind created", async () => {
    const raw = makeActivityEvent({ kind: "comment_created" });
    const msg = await normalizeActivityEvent(raw, mockAccount);

    expect(msg!.meta.recordableType).toBe("Comment");
    expect(msg!.meta.eventKind).toBe("created");
  });

  it("chat_transcript_rollup maps to Chat::Transcript with eventKind created", async () => {
    const raw = makeActivityEvent({
      kind: "chat_transcript_rollup",
      recording: { id: 201, type: "Chat::Transcript", content: "hello" },
    });
    const msg = await normalizeActivityEvent(raw, mockAccount);

    expect(msg!.meta.recordableType).toBe("Chat::Transcript");
    expect(msg!.meta.eventKind).toBe("created");
  });

  it("kanban_card_created maps to Kanban::Card", async () => {
    const raw = makeActivityEvent({
      kind: "kanban_card_created",
      recording: { id: 202, type: "Kanban::Card", title: "New card" },
    });
    const msg = await normalizeActivityEvent(raw, mockAccount);

    expect(msg!.meta.recordableType).toBe("Kanban::Card");
  });

  it("todo_completed maps to Todo with eventKind completed", async () => {
    const raw = makeActivityEvent({
      kind: "todo_completed",
      recording: { id: 203, type: "Todo", title: "Finish task" },
    });
    const msg = await normalizeActivityEvent(raw, mockAccount);

    expect(msg!.meta.recordableType).toBe("Todo");
    expect(msg!.meta.eventKind).toBe("completed");
  });

  it("message_created maps to Message", async () => {
    const raw = makeActivityEvent({
      kind: "message_created",
      recording: { id: 204, type: "Message", title: "Announcement" },
    });
    const msg = await normalizeActivityEvent(raw, mockAccount);

    expect(msg!.meta.recordableType).toBe("Message");
    expect(msg!.meta.eventKind).toBe("created");
  });

  it("unknown kind falls back to recognized recording.type", async () => {
    const raw = makeActivityEvent({
      kind: "some_unknown_kind",
      recording: { id: 205, type: "Upload", title: "File" },
    });
    const msg = await normalizeActivityEvent(raw, mockAccount);

    expect(msg!.meta.recordableType).toBe("Upload");
  });

  it("unknown kind with unrecognized recording.type returns null (dropped)", async () => {
    const raw = makeActivityEvent({
      kind: "some_unknown_kind",
      recording: { id: 206, type: "FutureType", title: "Something" },
    });
    const msg = await normalizeActivityEvent(raw, mockAccount);

    expect(msg).toBeNull();
  });

  it("sets sender from raw.creator fields", async () => {
    const raw = makeActivityEvent({
      creator: { id: 77, name: "Bob", email_address: "bob@example.com", avatar_url: "https://example.com/bob.png" },
    });
    const msg = await normalizeActivityEvent(raw, mockAccount);

    expect(msg!.sender).toEqual({
      id: "77",
      name: "Bob",
      email: "bob@example.com",
      avatarUrl: "https://example.com/bob.png",
    });
  });

  it("dedup key is activity:<event.id>", async () => {
    const raw = makeActivityEvent({ id: 12345 });
    const msg = await normalizeActivityEvent(raw, mockAccount);

    expect(msg!.dedupKey).toBe("activity:12345");
  });

  it("parentPeer is always bucket:<bucketId>", async () => {
    const raw = makeActivityEvent({ bucket: { id: 777, name: "Project" } });
    const msg = await normalizeActivityEvent(raw, mockAccount);

    expect(msg!.parentPeer).toEqual({ kind: "group", id: "bucket:777" });
  });

  it("comment_created with parentRecordingId routes peer to parent", async () => {
    const raw = makeActivityEvent({
      kind: "comment_created",
      parent_recording_id: 99,
      recording: { id: 200, type: "Comment" },
    });
    const msg = await normalizeActivityEvent(raw, mockAccount);

    expect(msg!.peer).toEqual({ kind: "group", id: "recording:99" });
  });

  it("extracts mentions from HTML content", async () => {
    const html = '<bc-attachment sgid="sgid://bc3/Person/42" content-type="application/vnd.basecamp.mention"></bc-attachment> hello';
    const raw = makeActivityEvent({
      recording: { id: 207, type: "Comment", content: html },
    });
    const msg = await normalizeActivityEvent(raw, mockAccount);

    expect(msg!.meta.mentions).toContain("sgid://bc3/Person/42");
  });

  it("sets mentionsAgent true when content has bc-attachment matching agent SGID", async () => {
    const html = '<bc-attachment sgid="sgid://bc3/Person/999" content-type="application/vnd.basecamp.mention"></bc-attachment> hey';
    const raw = makeActivityEvent({
      recording: { id: 208, type: "Comment", content: html },
    });
    const msg = await normalizeActivityEvent(raw, mockAccount);

    expect(msg!.meta.mentionsAgent).toBe(true);
  });

  it("sets mentionsAgent false when no agent mention", async () => {
    const raw = makeActivityEvent({
      recording: { id: 209, type: "Comment", content: "<p>No mentions here</p>" },
    });
    const msg = await normalizeActivityEvent(raw, mockAccount);

    expect(msg!.meta.mentionsAgent).toBe(false);
  });

  it("sets channel to basecamp and accountId from account", async () => {
    const raw = makeActivityEvent();
    const msg = await normalizeActivityEvent(raw, mockAccount);

    expect(msg!.channel).toBe("basecamp");
    expect(msg!.accountId).toBe("test-acct");
  });

  it("uses raw.created_at as createdAt", async () => {
    const raw = makeActivityEvent({ created_at: "2025-06-01T08:00:00Z" });
    const msg = await normalizeActivityEvent(raw, mockAccount);

    expect(msg!.createdAt).toBe("2025-06-01T08:00:00Z");
  });

  it("sets messageId on Comment recordableType", async () => {
    const raw = makeActivityEvent({
      kind: "comment_created",
      recording: { id: 210, type: "Comment" },
    });
    const msg = await normalizeActivityEvent(raw, mockAccount);

    expect(msg!.meta.messageId).toBe("210");
  });

  it("sources includes activity_feed", async () => {
    const raw = makeActivityEvent();
    const msg = await normalizeActivityEvent(raw, mockAccount);

    expect(msg!.meta.sources).toContain("activity_feed");
  });

  it("activity feed does not detect assignment (no assignedToAgent)", async () => {
    const acct = { ...mockAccount, displayName: "Clawdito" };
    const raw = makeActivityEvent({
      kind: "todo_assigned",
      target: "Clawdito",
      recording: { id: 203, type: "Todo", title: "Do the thing" },
    });
    const msg = await normalizeActivityEvent(raw, acct);

    // Assignment detection is only via webhook details or pollAssignments;
    // activity feed target field is the recording title, not the assignee.
    expect(msg!.meta.assignedToAgent).toBeUndefined();
    expect(msg!.meta.eventKind).toBe("assigned");
  });

  it("does not set assignedToAgent when target is a different person", async () => {
    const acct = { ...mockAccount, displayName: "Clawdito" };
    const raw = makeActivityEvent({
      kind: "todo_assigned",
      target: "Alice",
      recording: { id: 203, type: "Todo", title: "Do the thing" },
    });
    const msg = await normalizeActivityEvent(raw, acct);

    expect(msg!.meta.assignedToAgent).toBeUndefined();
  });

  it("does not set assignedToAgent for non-assignment event kinds", async () => {
    const acct = { ...mockAccount, displayName: "Clawdito" };
    const raw = makeActivityEvent({
      kind: "todo_completed",
      target: "Clawdito",
      recording: { id: 203, type: "Todo", title: "Do the thing" },
    });
    const msg = await normalizeActivityEvent(raw, acct);

    expect(msg!.meta.assignedToAgent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// normalizeReadingsEvent
// ---------------------------------------------------------------------------

describe("normalizeReadingsEvent", () => {
  it("returns null when app_url is missing", () => {
    const raw = makeReadingsEntry({ app_url: undefined });
    const result = normalizeReadingsEvent(raw, mockAccount);

    expect(result).toBeNull();
  });

  it("returns null when app_url has no bucket segment", () => {
    const raw = makeReadingsEntry({ app_url: "https://3.basecamp.com/no-bucket" });
    const result = normalizeReadingsEvent(raw, mockAccount);

    expect(result).toBeNull();
  });

  it("Card type maps to Kanban::Card", () => {
    const raw = makeReadingsEntry({ type: "Card" });
    const msg = normalizeReadingsEvent(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.meta.recordableType).toBe("Kanban::Card");
  });

  it("ChatLine type maps to Chat::Line", () => {
    const raw = makeReadingsEntry({ type: "ChatLine" });
    const msg = normalizeReadingsEvent(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.meta.recordableType).toBe("Chat::Line");
  });

  it("Ping type with 1 other participant (2 total) resolves to dm peer", () => {
    // BC3 readings participants uses other_circle_people() which excludes the caller.
    // 1 participant in array + 1 caller = 2 total → dm.
    const raw = makeReadingsEntry({
      type: "Ping",
      participants: [{ id: 1, name: "Alice" }],
    });
    const msg = normalizeReadingsEvent(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.peer.kind).toBe("dm");
    expect(msg!.peer.id).toMatch(/^ping:/);
  });

  it("Ping type with 2 other participants (3 total) resolves to group peer", () => {
    // 2 in array + 1 caller = 3 total → group.
    const raw = makeReadingsEntry({
      type: "Ping",
      participants: [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ],
    });
    const msg = normalizeReadingsEvent(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.peer.kind).toBe("group");
    expect(msg!.peer.id).toMatch(/^ping:/);
  });

  it("Ping type with 3+ other participants resolves to group peer", () => {
    const raw = makeReadingsEntry({
      type: "Ping",
      participants: [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
        { id: 3, name: "Charlie" },
      ],
    });
    const msg = normalizeReadingsEvent(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.peer.kind).toBe("group");
    expect(msg!.peer.id).toMatch(/^ping:/);
  });

  it("Ping type has no parentPeer", () => {
    const raw = makeReadingsEntry({
      type: "Ping",
      participants: [{ id: 1, name: "Alice" }],
    });
    const msg = normalizeReadingsEvent(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.parentPeer).toBeUndefined();
  });

  it("section mentions sets mentionsAgent true", () => {
    const raw = makeReadingsEntry({ section: "mentions" });
    const msg = normalizeReadingsEvent(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.meta.mentionsAgent).toBe(true);
  });

  it("dedup key is reading:<reading.id>", () => {
    const raw = makeReadingsEntry({ id: 555 });
    const msg = normalizeReadingsEvent(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.dedupKey).toBe("reading:555");
  });

  it("uses unread_at for createdAt when available", () => {
    const raw = makeReadingsEntry({
      unread_at: "2025-02-01T09:00:00Z",
      created_at: "2025-01-15T12:00:00Z",
    });
    const msg = normalizeReadingsEvent(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.createdAt).toBe("2025-02-01T09:00:00Z");
  });

  it("falls back to created_at when unread_at is missing", () => {
    const raw = makeReadingsEntry({
      unread_at: undefined,
      created_at: "2025-01-15T12:00:00Z",
    });
    const msg = normalizeReadingsEvent(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.createdAt).toBe("2025-01-15T12:00:00Z");
  });

  it("extracts recordingId from app_url when it contains a resource path", () => {
    const raw = makeReadingsEntry({
      app_url: "https://3.basecamp.com/buckets/100/cards/7777",
      readable_identifier: "Card/9999",
    });
    const msg = normalizeReadingsEvent(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.meta.recordingId).toBe("7777");
  });

  it("falls back to readable_identifier when app_url has no recording ID path", () => {
    const raw = makeReadingsEntry({
      app_url: "https://3.basecamp.com/buckets/100",
      readable_identifier: "Card/8888",
    });
    const msg = normalizeReadingsEvent(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.meta.recordingId).toBe("8888");
  });

  it("falls back to raw.id when readable_identifier has no ID", () => {
    const raw = makeReadingsEntry({
      id: 500,
      readable_identifier: "NoNumericSuffix",
    });
    const msg = normalizeReadingsEvent(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.meta.recordingId).toBe("500");
  });

  it("sets sender from raw.creator", () => {
    const raw = makeReadingsEntry({
      creator: { id: 88, name: "Carol", email_address: "carol@example.com" },
    });
    const msg = normalizeReadingsEvent(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.sender.id).toBe("88");
    expect(msg!.sender.name).toBe("Carol");
  });

  it("uses unknown sender when creator is missing", () => {
    const raw = makeReadingsEntry({ creator: undefined });
    const msg = normalizeReadingsEvent(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.sender.id).toBe("unknown");
    expect(msg!.sender.name).toBe("Unknown");
  });

  it("sources includes readings", () => {
    const raw = makeReadingsEntry();
    const msg = normalizeReadingsEvent(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.meta.sources).toContain("readings");
  });

  it("non-Ping type has parentPeer bucket:<bucketId>", () => {
    const raw = makeReadingsEntry({ type: "Card" });
    const msg = normalizeReadingsEvent(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.parentPeer).toEqual({ kind: "group", id: "bucket:100" });
  });
});

// ---------------------------------------------------------------------------
// normalizeWebhookPayload
// ---------------------------------------------------------------------------

describe("normalizeWebhookPayload", () => {
  it("normalizes basic webhook with bucket and recording", async () => {
    const raw = makeWebhookPayload();
    const msg = await normalizeWebhookPayload(raw, mockAccount);

    expect(msg!.channel).toBe("basecamp");
    expect(msg!.accountId).toBe("test-acct");
    expect(msg!.meta.bucketId).toBe("100");
    expect(msg!.meta.recordingId).toBe("300");
    expect(msg!.meta.recordableType).toBe("Comment");
  });

  it("uses recording.parent for parentRecordingId in peer resolution", async () => {
    const raw = makeWebhookPayload({
      kind: "comment_created",
      recording: {
        id: 300,
        type: "Comment",
        content: "<p>A comment</p>",
        parent: { id: 150, type: "Message" },
        bucket: { id: 100, name: "Test Project" },
      },
    });
    const msg = await normalizeWebhookPayload(raw, mockAccount);

    expect(msg!.peer).toEqual({ kind: "group", id: "recording:150" });
  });

  it("dedup key uses webhook ID when available", async () => {
    const raw = makeWebhookPayload({ id: 900 });
    const msg = await normalizeWebhookPayload(raw, mockAccount);

    expect(msg!.dedupKey).toBe("webhook:900");
  });

  it("dedup key uses composite fallback when webhook ID is missing", async () => {
    const raw = makeWebhookPayload({ id: undefined });
    const msg = await normalizeWebhookPayload(raw, mockAccount);

    expect(msg!.dedupKey).toMatch(/^webhook:300:comment_created:/);
  });

  it("extracts text from HTML content", async () => {
    const raw = makeWebhookPayload({
      recording: {
        id: 301,
        type: "Comment",
        content: "<p>Hello world</p>",
        bucket: { id: 100, name: "Test Project" },
      },
    });
    const msg = await normalizeWebhookPayload(raw, mockAccount);

    expect(msg!.text).toBe("Hello world");
    expect(msg!.html).toBe("<p>Hello world</p>");
  });

  it("sets sender from raw.creator", async () => {
    const raw = makeWebhookPayload({
      creator: { id: 55, name: "Dave", email_address: "dave@example.com" },
    });
    const msg = await normalizeWebhookPayload(raw, mockAccount);

    expect(msg!.sender.id).toBe("55");
    expect(msg!.sender.name).toBe("Dave");
    expect(msg!.sender.email).toBe("dave@example.com");
  });

  it("parentPeer is bucket:<bucketId>", async () => {
    const raw = makeWebhookPayload();
    const msg = await normalizeWebhookPayload(raw, mockAccount);

    expect(msg!.parentPeer).toEqual({ kind: "group", id: "bucket:100" });
  });

  it("sources includes webhook", async () => {
    const raw = makeWebhookPayload();
    const msg = await normalizeWebhookPayload(raw, mockAccount);

    expect(msg!.meta.sources).toContain("webhook");
  });

  it("detects agent mention in webhook content", async () => {
    const raw = makeWebhookPayload({
      recording: {
        id: 302,
        type: "Comment",
        content: '<bc-attachment sgid="sgid://bc3/Person/999" content-type="application/vnd.basecamp.mention"></bc-attachment> ping',
        bucket: { id: 100, name: "Test Project" },
      },
    });
    const msg = await normalizeWebhookPayload(raw, mockAccount);

    expect(msg!.meta.mentionsAgent).toBe(true);
  });

  it("uses recording.title when content is absent", async () => {
    const raw = makeWebhookPayload({
      recording: {
        id: 303,
        type: "Message",
        title: "Important Announcement",
        content: undefined,
        bucket: { id: 100, name: "Test Project" },
      },
    });
    const msg = await normalizeWebhookPayload(raw, mockAccount);

    expect(msg!.text).toBe("Important Announcement");
  });
});

// ---------------------------------------------------------------------------
// Step 4: Ping enrichment via Circle API
// ---------------------------------------------------------------------------

import { resolveCircleInfoCached } from "../src/outbound/send.js";
import { recordUnknownKind } from "../src/metrics.js";

describe("Ping participant enrichment", () => {
  it("activity Ping with Circle lookup returning 2 participants → dm", async () => {
    vi.mocked(resolveCircleInfoCached).mockResolvedValueOnce({
      transcriptId: "888",
      participantCount: 2,
    });
    const raw = makeActivityEvent({
      kind: "chat_transcript_created",
      app_url: "https://3.basecamp.com/circles/100/chats/200",
      recording: { id: 200, type: "Ping" },
    });
    const msg = await normalizeActivityEvent(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.peer.kind).toBe("dm");
    expect(msg!.peer.id).toBe("ping:100");
  });

  it("activity Ping with Circle lookup returning 3 participants → group", async () => {
    vi.mocked(resolveCircleInfoCached).mockResolvedValueOnce({
      transcriptId: "888",
      participantCount: 3,
    });
    const raw = makeActivityEvent({
      kind: "chat_transcript_created",
      app_url: "https://3.basecamp.com/circles/100/chats/200",
      recording: { id: 200, type: "Ping" },
    });
    const msg = await normalizeActivityEvent(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.peer.kind).toBe("group");
    expect(msg!.peer.id).toBe("ping:100");
  });

  it("activity Ping with Circle lookup failure → fail-closed dm fallback", async () => {
    vi.mocked(resolveCircleInfoCached).mockResolvedValueOnce(undefined);
    const raw = makeActivityEvent({
      kind: "chat_transcript_created",
      app_url: "https://3.basecamp.com/circles/100/chats/200",
      recording: { id: 200, type: "Ping" },
    });
    const msg = await normalizeActivityEvent(raw, mockAccount);

    expect(msg).not.toBeNull();
    // Fail closed: unknown participant count → dm, so DM policy applies
    expect(msg!.peer.kind).toBe("dm");
  });

  it("webhook Ping with Circle lookup returning 2 participants → dm", async () => {
    // BC3 webhook recording.type is recordable_type ("Chat::Transcript"), not "Ping".
    // Ping detection uses recording.bucket.type === "Circle" (from bucketable_type).
    vi.mocked(resolveCircleInfoCached).mockResolvedValueOnce({
      transcriptId: "888",
      participantCount: 2,
    });
    const raw = makeWebhookPayload({
      kind: "chat_transcript_created",
      recording: {
        id: 200,
        type: "Chat::Transcript",
        content: "hey",
        bucket: { id: 100, name: "Pings", type: "Circle" },
      },
    });
    const msg = await normalizeWebhookPayload(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.peer.kind).toBe("dm");
    expect(msg!.peer.id).toBe("ping:100");
  });

  it("webhook Chat::Transcript in Project bucket is NOT a Ping", async () => {
    vi.mocked(resolveCircleInfoCached).mockClear();
    const raw = makeWebhookPayload({
      kind: "chat_transcript_created",
      recording: {
        id: 201,
        type: "Chat::Transcript",
        content: "campfire message",
        bucket: { id: 100, name: "My Project", type: "Project" },
      },
    });
    const msg = await normalizeWebhookPayload(raw, mockAccount);

    expect(msg).not.toBeNull();
    // Project campfire → recording peer, not ping peer
    expect(msg!.peer.id).toBe("recording:201");
    expect(msg!.peer.kind).toBe("group");
    // Circle lookup should NOT have been called
    expect(resolveCircleInfoCached).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Step 4: Webhook assignment detection via details
// ---------------------------------------------------------------------------

describe("webhook assignment detection", () => {
  it("todo_assignment_changed with added_person_ids matching agent → assignedToAgent", async () => {
    const raw = makeWebhookPayload({
      kind: "todo_assignment_changed",
      details: { added_person_ids: [999, 123] },
      recording: {
        id: 400,
        type: "Todo",
        title: "Fix bug",
        bucket: { id: 100, name: "Project" },
      },
    });
    const msg = await normalizeWebhookPayload(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.meta.assignedToAgent).toBe(true);
    expect(msg!.meta.assignees).toEqual(["999", "123"]);
    expect(msg!.meta.recordableType).toBe("Todo");
    expect(msg!.meta.eventKind).toBe("assigned");
  });

  it("todo_assignment_changed with removed_person_ids matching agent → unassigned_from_agent", async () => {
    const raw = makeWebhookPayload({
      kind: "todo_assignment_changed",
      details: { removed_person_ids: [999] },
      recording: {
        id: 401,
        type: "Todo",
        title: "Fix bug",
        bucket: { id: 100, name: "Project" },
      },
    });
    const msg = await normalizeWebhookPayload(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.meta.assignedToAgent).toBeUndefined();
    expect(msg!.meta.matchedPatterns).toContain("unassigned_from_agent");
  });

  it("todo_assignment_changed with non-matching person IDs → no assignment", async () => {
    const raw = makeWebhookPayload({
      kind: "todo_assignment_changed",
      details: { added_person_ids: [123, 456] },
      recording: {
        id: 402,
        type: "Todo",
        title: "Fix bug",
        bucket: { id: 100, name: "Project" },
      },
    });
    const msg = await normalizeWebhookPayload(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.meta.assignedToAgent).toBeUndefined();
    expect(msg!.meta.assignees).toEqual(["123", "456"]);
  });

  it("kanban_card_assignment_changed maps to Kanban::Card with eventKind assigned", async () => {
    const raw = makeWebhookPayload({
      kind: "kanban_card_assignment_changed",
      details: { added_person_ids: [999] },
      recording: {
        id: 403,
        type: "Kanban::Card",
        title: "Card",
        bucket: { id: 100, name: "Project" },
      },
    });
    const msg = await normalizeWebhookPayload(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.meta.recordableType).toBe("Kanban::Card");
    expect(msg!.meta.eventKind).toBe("assigned");
    expect(msg!.meta.assignedToAgent).toBe(true);
  });

  it("assignment event without details field → no assignment detection", async () => {
    const raw = makeWebhookPayload({
      kind: "todo_assignment_changed",
      recording: {
        id: 404,
        type: "Todo",
        title: "Fix bug",
        bucket: { id: 100, name: "Project" },
      },
    });
    const msg = await normalizeWebhookPayload(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.meta.assignedToAgent).toBeUndefined();
    expect(msg!.meta.assignees).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Step 4: Activity feed does not detect assignments
// ---------------------------------------------------------------------------

describe("activity feed assignment removal", () => {
  it("todo_assignment_changed in activity feed has no assignedToAgent", async () => {
    const raw = makeActivityEvent({
      kind: "todo_assignment_changed",
      recording: { id: 500, type: "Todo", title: "Fix it" },
    });
    const msg = await normalizeActivityEvent(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.meta.assignedToAgent).toBeUndefined();
    expect(msg!.meta.eventKind).toBe("assigned");
  });
});

// ---------------------------------------------------------------------------
// Step 4: Unknown kind drop policy
// ---------------------------------------------------------------------------

describe("unknown kind drop policy", () => {
  it("activity event with unknown kind and unrecognized recording type returns null", async () => {
    const raw = makeActivityEvent({
      kind: "future_quantum_created",
      recording: { id: 200, type: "FutureQuantum", title: "Quantum" },
    });
    const msg = await normalizeActivityEvent(raw, mockAccount);

    expect(msg).toBeNull();
    expect(recordUnknownKind).toHaveBeenCalledWith("test-acct", "future_quantum_created");
  });

  it("webhook event with unknown kind returns null", async () => {
    const raw = makeWebhookPayload({
      kind: "future_quantum_created",
      recording: {
        id: 600,
        type: "FutureQuantum",
        title: "Quantum",
        bucket: { id: 100, name: "Project" },
      },
    });
    const msg = await normalizeWebhookPayload(raw, mockAccount);

    expect(msg).toBeNull();
    expect(recordUnknownKind).toHaveBeenCalledWith("test-acct", "future_quantum_created");
  });

  it("readings event with unknown type returns null", () => {
    const raw = makeReadingsEntry({ type: "FutureQuantum" });
    const msg = normalizeReadingsEvent(raw, mockAccount);

    expect(msg).toBeNull();
    expect(recordUnknownKind).toHaveBeenCalledWith("test-acct", "FutureQuantum");
  });

  it("unknown kind but recognized recording.type still resolves", async () => {
    const raw = makeActivityEvent({
      kind: "some_unknown_kind",
      recording: { id: 601, type: "Upload", title: "A file" },
    });
    const msg = await normalizeActivityEvent(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.meta.recordableType).toBe("Upload");
  });
});
