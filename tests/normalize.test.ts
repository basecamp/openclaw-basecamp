import { describe, it, expect } from "vitest";
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

  it("Ping with 0 participants defaults to group (unknown count)", () => {
    const peer = resolveBasecampPeer({
      recordableType: "Chat::Transcript",
      recordingId: "50",
      bucketId: "200",
      isPing: true,
      participantCount: 0,
    });
    expect(peer).toEqual({ kind: "group", id: "ping:200" });
  });

  it("Ping with undefined participants defaults to group", () => {
    const peer = resolveBasecampPeer({
      recordableType: "Chat::Transcript",
      recordingId: "50",
      bucketId: "200",
      isPing: true,
      participantCount: undefined,
    });
    expect(peer).toEqual({ kind: "group", id: "ping:200" });
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
  it("comment_created maps to recordableType Comment and eventKind created", () => {
    const raw = makeActivityEvent({ kind: "comment_created" });
    const msg = normalizeActivityEvent(raw, mockAccount);

    expect(msg.meta.recordableType).toBe("Comment");
    expect(msg.meta.eventKind).toBe("created");
  });

  it("chat_transcript_rollup maps to Chat::Transcript with eventKind created", () => {
    const raw = makeActivityEvent({
      kind: "chat_transcript_rollup",
      recording: { id: 201, type: "Chat::Transcript", content: "hello" },
    });
    const msg = normalizeActivityEvent(raw, mockAccount);

    expect(msg.meta.recordableType).toBe("Chat::Transcript");
    expect(msg.meta.eventKind).toBe("created");
  });

  it("kanban_card_created maps to Kanban::Card", () => {
    const raw = makeActivityEvent({
      kind: "kanban_card_created",
      recording: { id: 202, type: "Kanban::Card", title: "New card" },
    });
    const msg = normalizeActivityEvent(raw, mockAccount);

    expect(msg.meta.recordableType).toBe("Kanban::Card");
  });

  it("todo_completed maps to Todo with eventKind completed", () => {
    const raw = makeActivityEvent({
      kind: "todo_completed",
      recording: { id: 203, type: "Todo", title: "Finish task" },
    });
    const msg = normalizeActivityEvent(raw, mockAccount);

    expect(msg.meta.recordableType).toBe("Todo");
    expect(msg.meta.eventKind).toBe("completed");
  });

  it("message_created maps to Message", () => {
    const raw = makeActivityEvent({
      kind: "message_created",
      recording: { id: 204, type: "Message", title: "Announcement" },
    });
    const msg = normalizeActivityEvent(raw, mockAccount);

    expect(msg.meta.recordableType).toBe("Message");
    expect(msg.meta.eventKind).toBe("created");
  });

  it("unknown kind falls back to recording.type when available", () => {
    const raw = makeActivityEvent({
      kind: "some_unknown_kind",
      recording: { id: 205, type: "Upload", title: "File" },
    });
    const msg = normalizeActivityEvent(raw, mockAccount);

    expect(msg.meta.recordableType).toBe("Upload");
  });

  it("unknown kind with unrecognized recording.type falls back to Document", () => {
    const raw = makeActivityEvent({
      kind: "some_unknown_kind",
      recording: { id: 206, type: "FutureType", title: "Something" },
    });
    const msg = normalizeActivityEvent(raw, mockAccount);

    expect(msg.meta.recordableType).toBe("Document");
  });

  it("sets sender from raw.creator fields", () => {
    const raw = makeActivityEvent({
      creator: { id: 77, name: "Bob", email_address: "bob@example.com", avatar_url: "https://example.com/bob.png" },
    });
    const msg = normalizeActivityEvent(raw, mockAccount);

    expect(msg.sender).toEqual({
      id: "77",
      name: "Bob",
      email: "bob@example.com",
      avatarUrl: "https://example.com/bob.png",
    });
  });

  it("dedup key is activity:<event.id>", () => {
    const raw = makeActivityEvent({ id: 12345 });
    const msg = normalizeActivityEvent(raw, mockAccount);

    expect(msg.dedupKey).toBe("activity:12345");
  });

  it("parentPeer is always bucket:<bucketId>", () => {
    const raw = makeActivityEvent({ bucket: { id: 777, name: "Project" } });
    const msg = normalizeActivityEvent(raw, mockAccount);

    expect(msg.parentPeer).toEqual({ kind: "group", id: "bucket:777" });
  });

  it("comment_created with parentRecordingId routes peer to parent", () => {
    const raw = makeActivityEvent({
      kind: "comment_created",
      parent_recording_id: 99,
      recording: { id: 200, type: "Comment" },
    });
    const msg = normalizeActivityEvent(raw, mockAccount);

    expect(msg.peer).toEqual({ kind: "group", id: "recording:99" });
  });

  it("extracts mentions from HTML content", () => {
    const html = '<bc-attachment sgid="sgid://bc3/Person/42" content-type="application/vnd.basecamp.mention"></bc-attachment> hello';
    const raw = makeActivityEvent({
      recording: { id: 207, type: "Comment", content: html },
    });
    const msg = normalizeActivityEvent(raw, mockAccount);

    expect(msg.meta.mentions).toContain("sgid://bc3/Person/42");
  });

  it("sets mentionsAgent true when content has bc-attachment matching agent SGID", () => {
    const html = '<bc-attachment sgid="sgid://bc3/Person/999" content-type="application/vnd.basecamp.mention"></bc-attachment> hey';
    const raw = makeActivityEvent({
      recording: { id: 208, type: "Comment", content: html },
    });
    const msg = normalizeActivityEvent(raw, mockAccount);

    expect(msg.meta.mentionsAgent).toBe(true);
  });

  it("sets mentionsAgent false when no agent mention", () => {
    const raw = makeActivityEvent({
      recording: { id: 209, type: "Comment", content: "<p>No mentions here</p>" },
    });
    const msg = normalizeActivityEvent(raw, mockAccount);

    expect(msg.meta.mentionsAgent).toBe(false);
  });

  it("sets channel to basecamp and accountId from account", () => {
    const raw = makeActivityEvent();
    const msg = normalizeActivityEvent(raw, mockAccount);

    expect(msg.channel).toBe("basecamp");
    expect(msg.accountId).toBe("test-acct");
  });

  it("uses raw.created_at as createdAt", () => {
    const raw = makeActivityEvent({ created_at: "2025-06-01T08:00:00Z" });
    const msg = normalizeActivityEvent(raw, mockAccount);

    expect(msg.createdAt).toBe("2025-06-01T08:00:00Z");
  });

  it("sets messageId on Comment recordableType", () => {
    const raw = makeActivityEvent({
      kind: "comment_created",
      recording: { id: 210, type: "Comment" },
    });
    const msg = normalizeActivityEvent(raw, mockAccount);

    expect(msg.meta.messageId).toBe("210");
  });

  it("sources includes activity_feed", () => {
    const raw = makeActivityEvent();
    const msg = normalizeActivityEvent(raw, mockAccount);

    expect(msg.meta.sources).toContain("activity_feed");
  });

  it("sets assignedToAgent when assignment target matches agent displayName", () => {
    const acct = { ...mockAccount, displayName: "Clawdito" };
    const raw = makeActivityEvent({
      kind: "todo_assigned",
      target: "Clawdito",
      recording: { id: 203, type: "Todo", title: "Do the thing" },
    });
    const msg = normalizeActivityEvent(raw, acct);

    expect(msg.meta.assignedToAgent).toBe(true);
    expect(msg.meta.eventKind).toBe("assigned");
  });

  it("does not set assignedToAgent when target is a different person", () => {
    const acct = { ...mockAccount, displayName: "Clawdito" };
    const raw = makeActivityEvent({
      kind: "todo_assigned",
      target: "Alice",
      recording: { id: 203, type: "Todo", title: "Do the thing" },
    });
    const msg = normalizeActivityEvent(raw, acct);

    expect(msg.meta.assignedToAgent).toBeUndefined();
  });

  it("does not set assignedToAgent for non-assignment event kinds", () => {
    const acct = { ...mockAccount, displayName: "Clawdito" };
    const raw = makeActivityEvent({
      kind: "todo_completed",
      target: "Clawdito",
      recording: { id: 203, type: "Todo", title: "Do the thing" },
    });
    const msg = normalizeActivityEvent(raw, acct);

    expect(msg.meta.assignedToAgent).toBeUndefined();
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

  it("Ping type with <= 2 participants resolves to dm peer", () => {
    const raw = makeReadingsEntry({
      type: "Ping",
      participants: [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ],
    });
    const msg = normalizeReadingsEvent(raw, mockAccount);

    expect(msg).not.toBeNull();
    expect(msg!.peer.kind).toBe("dm");
    expect(msg!.peer.id).toMatch(/^ping:/);
  });

  it("Ping type with > 2 participants resolves to group peer", () => {
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
  it("normalizes basic webhook with bucket and recording", () => {
    const raw = makeWebhookPayload();
    const msg = normalizeWebhookPayload(raw, mockAccount);

    expect(msg.channel).toBe("basecamp");
    expect(msg.accountId).toBe("test-acct");
    expect(msg.meta.bucketId).toBe("100");
    expect(msg.meta.recordingId).toBe("300");
    expect(msg.meta.recordableType).toBe("Comment");
  });

  it("uses recording.parent for parentRecordingId in peer resolution", () => {
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
    const msg = normalizeWebhookPayload(raw, mockAccount);

    expect(msg.peer).toEqual({ kind: "group", id: "recording:150" });
  });

  it("dedup key uses webhook ID when available", () => {
    const raw = makeWebhookPayload({ id: 900 });
    const msg = normalizeWebhookPayload(raw, mockAccount);

    expect(msg.dedupKey).toBe("webhook:900");
  });

  it("dedup key uses composite fallback when webhook ID is missing", () => {
    const raw = makeWebhookPayload({ id: undefined });
    const msg = normalizeWebhookPayload(raw, mockAccount);

    expect(msg.dedupKey).toMatch(/^webhook:300:comment_created:/);
  });

  it("extracts text from HTML content", () => {
    const raw = makeWebhookPayload({
      recording: {
        id: 301,
        type: "Comment",
        content: "<p>Hello world</p>",
        bucket: { id: 100, name: "Test Project" },
      },
    });
    const msg = normalizeWebhookPayload(raw, mockAccount);

    expect(msg.text).toBe("Hello world");
    expect(msg.html).toBe("<p>Hello world</p>");
  });

  it("sets sender from raw.creator", () => {
    const raw = makeWebhookPayload({
      creator: { id: 55, name: "Dave", email_address: "dave@example.com" },
    });
    const msg = normalizeWebhookPayload(raw, mockAccount);

    expect(msg.sender.id).toBe("55");
    expect(msg.sender.name).toBe("Dave");
    expect(msg.sender.email).toBe("dave@example.com");
  });

  it("parentPeer is bucket:<bucketId>", () => {
    const raw = makeWebhookPayload();
    const msg = normalizeWebhookPayload(raw, mockAccount);

    expect(msg.parentPeer).toEqual({ kind: "group", id: "bucket:100" });
  });

  it("sources includes webhook", () => {
    const raw = makeWebhookPayload();
    const msg = normalizeWebhookPayload(raw, mockAccount);

    expect(msg.meta.sources).toContain("webhook");
  });

  it("detects agent mention in webhook content", () => {
    const raw = makeWebhookPayload({
      recording: {
        id: 302,
        type: "Comment",
        content: '<bc-attachment sgid="sgid://bc3/Person/999" content-type="application/vnd.basecamp.mention"></bc-attachment> ping',
        bucket: { id: 100, name: "Test Project" },
      },
    });
    const msg = normalizeWebhookPayload(raw, mockAccount);

    expect(msg.meta.mentionsAgent).toBe(true);
  });

  it("uses recording.title when content is absent", () => {
    const raw = makeWebhookPayload({
      recording: {
        id: 303,
        type: "Message",
        title: "Important Announcement",
        content: undefined,
        bucket: { id: 100, name: "Test Project" },
      },
    });
    const msg = normalizeWebhookPayload(raw, mockAccount);

    expect(msg.text).toBe("Important Announcement");
  });
});
