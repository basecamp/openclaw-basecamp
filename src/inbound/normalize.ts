/**
 * Normalize raw Basecamp API data into BasecampInboundMessage.
 *
 * This is the most domain-specific module in the plugin. It transforms:
 * - Activity feed events (GET /timelines.json)
 * - Hey! Readings entries (GET /my/readings.json)
 * - Webhook payloads
 *
 * into the canonical BasecampInboundMessage shape used by dispatch.ts.
 */

import type {
  BasecampActivityEvent,
  BasecampInboundMessage,
  BasecampInboundMeta,
  BasecampPeer,
  BasecampReadingsEntry,
  BasecampRecordableType,
  BasecampSender,
  BasecampWebhookPayload,
  ResolvedBasecampAccount,
} from "../types.js";
import { mentionsAgent, extractAttachmentSgids, htmlToPlainText } from "../mentions/parse.js";
import { EventDedup } from "./dedup.js";

// ---------------------------------------------------------------------------
// event.kind → recordableType mapping (expanded from TimelinesApiHelper)
// ---------------------------------------------------------------------------

const KIND_TO_RECORDABLE_TYPE: Record<string, BasecampRecordableType> = {
  // Comments
  comment_created: "Comment",

  // Campfire / Chat
  chat_transcript_created: "Chat::Transcript",
  chat_transcript_rollup: "Chat::Transcript",

  // Todos
  todo_created: "Todo",
  todo_completed: "Todo",
  todo_assigned: "Todo",
  todo_unassigned: "Todo",

  // Todolists / Todosets
  todolist_created: "Todolist",
  todoset_created: "Todolist",

  // Kanban / Card Table
  kanban_card_created: "Kanban::Card",
  kanban_card_completed: "Kanban::Card",
  kanban_card_moved: "Kanban::Card",
  kanban_card_assigned: "Kanban::Card",
  kanban_step_created: "Kanban::Card",
  kanban_step_completed: "Kanban::Card",
  kanban_column_created: "Kanban::Column",

  // Messages
  message_created: "Message",
  message_board_created: "Message",

  // Questions / Check-ins
  question_created: "Question",
  question_answer_created: "Question::Answer",

  // Documents
  document_created: "Document",
  document_edited: "Document",

  // Uploads
  upload_created: "Upload",
  upload_blob_changed: "Upload",

  // Vaults
  vault_created: "Vault",

  // Schedule
  schedule_entry_created: "Schedule::Entry",
  schedule_entry_rescheduled: "Schedule::Entry",
  schedule_created: "Schedule::Entry",

  // Inbox
  inbox_forward_created: "Message",
  inbox_reply_created: "Comment",
  client_reply_created: "Comment",
  client_forward_created: "Message",
};

/** Map event.kind to a normalized eventKind for our domain model. */
function resolveEventKind(kind: string): string {
  if (kind.endsWith("_created")) return "created";
  if (kind.endsWith("_completed")) return "completed";
  if (kind.endsWith("_edited") || kind === "edited") return "edited";
  if (kind.endsWith("_deleted") || kind === "deleted") return "deleted";
  if (kind.endsWith("_rollup")) return "created";
  if (kind.endsWith("_rescheduled")) return "edited";
  if (kind.endsWith("_moved")) return "moved";
  if (kind.endsWith("_assigned")) return "assigned";
  if (kind.endsWith("_unassigned")) return "assigned";
  return kind;
}

/** Resolve recordable type from event kind, falling back to recording.type. */
function resolveRecordableType(
  kind: string,
  recordingType?: string,
): BasecampRecordableType | undefined {
  const mapped = KIND_TO_RECORDABLE_TYPE[kind];
  if (mapped) return mapped;

  if (recordingType) {
    const normalized = normalizeRecordingType(recordingType);
    if (normalized) return normalized;
  }

  // Return undefined for unknown types — caller decides how to handle
  return undefined;
}

// ---------------------------------------------------------------------------
// readings.type → recordableType mapping
// ---------------------------------------------------------------------------

const READINGS_TYPE_MAP: Record<string, BasecampRecordableType> = {
  Card: "Kanban::Card",
  ChatLine: "Chat::Line",
  Ping: "Chat::Transcript",
  Message: "Message",
  Todo: "Todo",
  Todolist: "Todolist",
  Question: "Question",
  QuestionAnswer: "Question::Answer",
  Document: "Document",
  Upload: "Upload",
  Comment: "Comment",
  ScheduleEntry: "Schedule::Entry",
};

function normalizeRecordingType(type: string): BasecampRecordableType | undefined {
  if (type in READINGS_TYPE_MAP) return READINGS_TYPE_MAP[type];

  if (type.includes("::")) {
    const known: string[] = [
      "Chat::Transcript", "Chat::Line", "Kanban::Card", "Kanban::Column",
      "Comment", "Message", "Todo", "Todolist", "Question", "Question::Answer",
      "Document", "Upload", "Vault", "Schedule::Entry",
    ];
    if (known.includes(type)) return type as BasecampRecordableType;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// URL parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract bucket ID from a Basecamp app URL.
 * Supports /buckets/<id>/... and /circles/<id>/... (Pings).
 */
export function parseBucketIdFromUrl(url: string): string | undefined {
  const match = /\/(?:buckets|circles)\/(\d+)/.exec(url);
  return match ? match[1] : undefined;
}

/**
 * Extract recording ID from a Basecamp app URL.
 * Parses the last numeric path segment after the bucket/resource type:
 *   /buckets/123/messages/456 → "456"
 *   /buckets/123/chats/456/lines/789 → "789"
 *   /buckets/123/recordings/456 → "456"
 */
export function parseRecordingIdFromUrl(url: string): string | undefined {
  // Match the last /<resource-type>/<numeric-id> in the URL
  const match = /\/(?:messages|todos|todolists|cards|chats|recordings|comments|documents|uploads|vaults|questions|question_answers|schedule_entries|lines|forwards|replies)\/(\d+)/.exec(url);
  return match ? match[1] : undefined;
}

/** Extract recording ID from a readable_identifier (e.g., "Comment/123"). */
export function parseRecordingIdFromIdentifier(identifier: string): string | undefined {
  const match = /\/(\d+)$/.exec(identifier);
  return match ? match[1] : undefined;
}

// ---------------------------------------------------------------------------
// Peer resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the OpenClaw peer for a normalized event.
 *
 * - Chat::Line → parent transcript: recording:<transcriptId>
 * - Comment → parent recording: recording:<parentRecordingId>
 * - Pings → ping:<circleBucketId> (dm if participant count known ≤2, else group)
 * - Everything else → recording:<recordingId>
 */
export function resolveBasecampPeer(params: {
  recordableType: BasecampRecordableType;
  recordingId: string;
  parentRecordingId?: string;
  bucketId: string;
  isPing?: boolean;
  participantCount?: number;
}): BasecampPeer {
  const { recordableType, recordingId, parentRecordingId, bucketId, isPing, participantCount } =
    params;

  if (isPing) {
    // Default to "group" when participant count is unknown (undefined/0).
    // Only classify as "dm" when we positively know there are ≤2 participants.
    const kind = participantCount != null && participantCount > 0 && participantCount <= 2
      ? "dm"
      : "group";
    return { kind, id: `ping:${bucketId}` };
  }

  if (recordableType === "Chat::Line" && parentRecordingId) {
    return { kind: "group", id: `recording:${parentRecordingId}` };
  }

  if (recordableType === "Comment" && parentRecordingId) {
    return { kind: "group", id: `recording:${parentRecordingId}` };
  }

  if (recordableType === "Chat::Transcript") {
    return { kind: "group", id: `recording:${recordingId}` };
  }

  return { kind: "group", id: `recording:${recordingId}` };
}

/**
 * Resolve parent peer for project-level routing.
 * bucket:<bucketId> for non-Pings, undefined for Pings.
 */
export function resolveParentPeer(
  bucketId: string,
  isPing: boolean,
): BasecampPeer | undefined {
  if (isPing) return undefined;
  return { kind: "group", id: `bucket:${bucketId}` };
}

// ---------------------------------------------------------------------------
// Self-message detection
// ---------------------------------------------------------------------------

export function isSelfMessage(
  creatorId: string | number,
  account: ResolvedBasecampAccount,
): boolean {
  return String(creatorId) === String(account.personId);
}

// ---------------------------------------------------------------------------
// Activity feed normalization
// ---------------------------------------------------------------------------

/**
 * Normalize an activity feed event into a BasecampInboundMessage.
 *
 * IMPORTANT: bc3's _event.json.jbuilder does NOT emit a `recording` object
 * on timeline events. Only top-level fields are available: `app_url`,
 * `parent_recording_id`, `summary_excerpt`, `title`, etc.
 * Recording ID must be parsed from `app_url`.
 */
export function normalizeActivityEvent(
  raw: BasecampActivityEvent,
  account: ResolvedBasecampAccount,
): BasecampInboundMessage {
  const recordableType = resolveRecordableType(
    raw.kind,
    raw.recording?.recordable_type ?? raw.recording?.type,
  );

  const bucketId = String(raw.bucket.id);

  // Parse recording ID from app_url — timeline events don't reliably
  // include recording.id in their JSON. Fall back to parent_recording_id
  // for comment events, then to the event's own ID as last resort.
  let recordingId: string | undefined;
  if (raw.app_url) {
    recordingId = parseRecordingIdFromUrl(raw.app_url);
  }
  if (!recordingId && raw.recording?.id) {
    recordingId = String(raw.recording.id);
  }
  if (!recordingId && raw.parent_recording_id) {
    recordingId = String(raw.parent_recording_id);
  }
  // Last resort: use event ID, but log a warning (callers see this in meta)
  if (!recordingId) {
    recordingId = String(raw.id);
  }

  const parentRecordingId = raw.parent_recording_id
    ? String(raw.parent_recording_id)
    : undefined;

  const content = raw.recording?.content ?? raw.summary_excerpt ?? raw.title ?? "";
  const text = content ? htmlToPlainText(content) : (raw.title ?? "");
  const html = content || "";

  const sgids = extractAttachmentSgids(html);
  const isAgentMentioned = mentionsAgent(html, account.attachableSgid, account.personId);

  const sender: BasecampSender = {
    id: String(raw.creator.id),
    name: raw.creator.name,
    email: raw.creator.email_address,
    avatarUrl: raw.creator.avatar_url,
  };

  const effectiveRecordableType = recordableType ?? "Document";

  const peer = resolveBasecampPeer({
    recordableType: effectiveRecordableType,
    recordingId,
    parentRecordingId,
    bucketId,
  });

  const parentPeer = resolveParentPeer(bucketId, false);

  // Detect assignment events directed at the agent.
  // bc3 assignment event kinds put the assignee's display name in `target`.
  const isAssignmentKind = raw.kind.endsWith("_assigned") || raw.kind.endsWith("_unassigned");
  const isAssignedToAgent = isAssignmentKind &&
    typeof raw.target === "string" &&
    typeof account.displayName === "string" &&
    raw.target === account.displayName;

  const meta: BasecampInboundMeta = {
    bucketId,
    recordingId,
    recordableType: effectiveRecordableType,
    eventKind: resolveEventKind(raw.kind) as BasecampInboundMeta["eventKind"],
    mentions: sgids,
    mentionsAgent: isAgentMentioned,
    assignedToAgent: isAssignedToAgent || undefined,
    attachments: (raw.attachments ?? []).map((a) => ({
      sgid: a.sgid ?? "",
      url: a.url,
      contentType: a.content_type,
      filename: a.filename,
      byteSize: a.byte_size,
    })),
    sources: ["activity_feed"],
  };

  if (effectiveRecordableType === "Comment" || effectiveRecordableType === "Chat::Line") {
    meta.messageId = recordingId;
  }

  // Preserve the raw kind for unknown types so dispatch/agents can inspect it
  if (!recordableType) {
    meta.matchedPatterns = [`unknown_kind:${raw.kind}`];
  }

  const dedupPrimary = EventDedup.primaryKey("activity", String(raw.id));

  return {
    channel: "basecamp",
    accountId: account.accountId,
    peer,
    parentPeer,
    sender,
    text,
    html,
    meta,
    dedupKey: dedupPrimary,
    createdAt: raw.created_at,
  };
}

// ---------------------------------------------------------------------------
// Readings normalization
// ---------------------------------------------------------------------------

export function normalizeReadingsEvent(
  raw: BasecampReadingsEntry,
  account: ResolvedBasecampAccount,
): BasecampInboundMessage | null {
  // Support both /buckets/<id> and /circles/<id> URLs (Pings use circles)
  const bucketId = raw.app_url ? parseBucketIdFromUrl(raw.app_url) : undefined;
  if (!bucketId) return null;

  // Parse recording ID from app_url first, then identifier, then fallback
  let recordingId: string | undefined;
  if (raw.app_url) {
    recordingId = parseRecordingIdFromUrl(raw.app_url);
  }
  if (!recordingId && raw.readable_identifier) {
    recordingId = parseRecordingIdFromIdentifier(raw.readable_identifier);
  }
  if (!recordingId) {
    recordingId = String(raw.id);
  }

  const recordableType = normalizeRecordingType(raw.type);
  const isPing = raw.type === "Ping";
  const participantCount = raw.participants?.length;

  const text = raw.content_excerpt ? htmlToPlainText(raw.content_excerpt) : (raw.title ?? "");
  const html = raw.content_excerpt ?? "";

  const sgids = extractAttachmentSgids(html);
  const isAgentMentioned =
    mentionsAgent(html, account.attachableSgid, account.personId) ||
    raw.section === "mentions";

  const sender: BasecampSender = raw.creator
    ? {
        id: String(raw.creator.id),
        name: raw.creator.name,
        email: raw.creator.email_address,
        avatarUrl: raw.creator.avatar_url,
      }
    : { id: "unknown", name: "Unknown" };

  const effectiveRecordableType = recordableType ?? "Document";

  const peer = resolveBasecampPeer({
    recordableType: effectiveRecordableType,
    recordingId,
    bucketId,
    isPing,
    participantCount,
  });

  const parentPeer = resolveParentPeer(bucketId, isPing);

  const meta: BasecampInboundMeta = {
    bucketId,
    recordingId,
    recordableType: effectiveRecordableType,
    eventKind: "created" as BasecampInboundMeta["eventKind"],
    mentions: sgids,
    mentionsAgent: isAgentMentioned,
    attachments: (raw.previewable_attachments ?? []).map((a) => ({
      sgid: a.sgid ?? "",
      url: a.url,
      contentType: a.content_type,
    })),
    sources: ["readings"],
  };

  // Preserve unknown type info
  if (!recordableType) {
    meta.matchedPatterns = [`unknown_type:${raw.type}`];
  }

  const dedupPrimary = EventDedup.primaryKey("reading", String(raw.id));

  return {
    channel: "basecamp",
    accountId: account.accountId,
    peer,
    parentPeer,
    sender,
    text,
    html,
    meta,
    dedupKey: dedupPrimary,
    createdAt: raw.unread_at ?? raw.created_at,
  };
}

// ---------------------------------------------------------------------------
// Webhook normalization
// ---------------------------------------------------------------------------

export function normalizeWebhookPayload(
  raw: BasecampWebhookPayload,
  account: ResolvedBasecampAccount,
): BasecampInboundMessage {
  const recordableType = resolveRecordableType(raw.kind, raw.recording.type);
  const effectiveRecordableType = recordableType ?? "Document";
  const recordingId = String(raw.recording.id);
  const parentRecordingId = raw.recording.parent
    ? String(raw.recording.parent.id)
    : undefined;
  const bucketId = String(raw.recording.bucket.id);

  const content = raw.recording.content ?? raw.recording.title ?? "";
  const text = content ? htmlToPlainText(content) : "";
  const html = content;

  const sgids = extractAttachmentSgids(html);
  const isAgentMentioned = mentionsAgent(html, account.attachableSgid, account.personId);

  const sender: BasecampSender = {
    id: String(raw.creator.id),
    name: raw.creator.name,
    email: raw.creator.email_address,
  };

  const peer = resolveBasecampPeer({
    recordableType: effectiveRecordableType,
    recordingId,
    parentRecordingId,
    bucketId,
  });

  const parentPeer = resolveParentPeer(bucketId, false);

  const meta: BasecampInboundMeta = {
    bucketId,
    recordingId,
    recordableType: effectiveRecordableType,
    eventKind: resolveEventKind(raw.kind) as BasecampInboundMeta["eventKind"],
    mentions: sgids,
    mentionsAgent: isAgentMentioned,
    attachments: [],
    sources: ["webhook"],
  };

  if (!recordableType) {
    meta.matchedPatterns = [`unknown_kind:${raw.kind}`];
  }

  const dedupPrimary = raw.id
    ? EventDedup.primaryKey("webhook", String(raw.id))
    : `webhook:${recordingId}:${raw.kind}:${raw.created_at}`;

  return {
    channel: "basecamp",
    accountId: account.accountId,
    peer,
    parentPeer,
    sender,
    text,
    html,
    meta,
    dedupKey: dedupPrimary,
    createdAt: raw.created_at,
  };
}
