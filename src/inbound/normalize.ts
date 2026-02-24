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

import crypto from "node:crypto";
import type {
  BasecampActivityEvent,
  BasecampAssignmentTodo,
  BasecampInboundMessage,
  BasecampInboundMeta,
  BasecampPeer,
  BasecampReadingsEntry,
  BasecampRecordableType,
  BasecampSender,
  BasecampWebhookPayload,
  WebhookEventDetails,
  ResolvedBasecampAccount,
} from "../types.js";
import { mentionsAgent, extractAttachmentSgids, htmlToPlainText } from "../mentions/parse.js";
import { EventDedup } from "./dedup.js";
import { recordUnknownKind } from "../metrics.js";
import { resolveCircleInfoCached } from "../outbound/send.js";

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

  // Assignments (via BC3 Recording::Assignable — kind is *_assignment_changed)
  todo_assignment_changed: "Todo",
  kanban_card_assignment_changed: "Kanban::Card",
  kanban_step_assignment_changed: "Kanban::Card",
};

/** Check if a raw event kind is normalizable (has an entry in KIND_TO_RECORDABLE_TYPE). */
export function isNormalizableKind(kind: string): boolean {
  return kind in KIND_TO_RECORDABLE_TYPE;
}

/** Get the recordable type for a raw event kind, or undefined. */
export function recordableTypeForKind(kind: string): BasecampRecordableType | undefined {
  return KIND_TO_RECORDABLE_TYPE[kind];
}

/** Map event.kind to a normalized eventKind for our domain model. */
function resolveEventKind(kind: string): string {
  if (kind.endsWith("_created")) return "created";
  if (kind.endsWith("_completed")) return "completed";
  if (kind.endsWith("_edited") || kind === "edited") return "edited";
  if (kind.endsWith("_deleted") || kind === "deleted") return "deleted";
  if (kind.endsWith("_rollup")) return "created";
  if (kind.endsWith("_rescheduled")) return "edited";
  if (kind.endsWith("_moved")) return "moved";
  if (kind.endsWith("_assignment_changed")) return "assigned";
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
 * - Pings → ping:<circleBucketId> (group if participant count known >2, else dm — fail-closed)
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
    // Fail closed: when participant count is unknown (Circle API failure),
    // default to "dm" so DM policy applies. This prevents API outages from
    // relaxing DM gating on actual 1:1 Pings by misclassifying them as group.
    // When count is known: ≤2 = dm, >2 = group.
    const kind = participantCount != null && participantCount > 2
      ? "group"
      : "dm";
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
// Webhook assignment detail helpers
// ---------------------------------------------------------------------------

/** True when the BC3 event kind represents an assignment change. */
function isAssignmentChangedKind(kind: string): boolean {
  return kind.endsWith("_assignment_changed");
}

/**
 * Parse assignment person IDs from webhook event details.
 * BC3 Event::Detail::PeopleChanges writes `added_person_ids` and
 * `removed_person_ids` as integer arrays. Validates each element.
 */
function parseAssignmentDetails(details: WebhookEventDetails | undefined): {
  addedPersonIds: number[];
  removedPersonIds: number[];
} {
  const addedRaw = details?.added_person_ids;
  const removedRaw = details?.removed_person_ids;
  return {
    addedPersonIds: Array.isArray(addedRaw) ? addedRaw.filter((id): id is number => typeof id === "number") : [],
    removedPersonIds: Array.isArray(removedRaw) ? removedRaw.filter((id): id is number => typeof id === "number") : [],
  };
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
export async function normalizeActivityEvent(
  raw: BasecampActivityEvent,
  account: ResolvedBasecampAccount,
): Promise<BasecampInboundMessage | null> {
  const recordableType = resolveRecordableType(
    raw.kind,
    raw.recording?.recordable_type ?? raw.recording?.type,
  );

  // Unknown kind → drop with metric rather than misclassifying as Document
  if (!recordableType) {
    recordUnknownKind(account.accountId, raw.kind);
    return null;
  }

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

  // Detect Pings: activity events for Pings use /circles/<id> URLs
  // instead of /buckets/<id>. Also check recording.type if available.
  const isPing =
    raw.app_url?.includes("/circles/") === true ||
    raw.recording?.type === "Ping" ||
    raw.recording?.recordable_type === "Ping";

  // Enrich Ping participant count via Circle API (activity feed lacks it).
  // Defaults to undefined → resolveBasecampPeer fail-closed uses "dm".
  let participantCount: number | undefined;
  if (isPing) {
    const circleInfo = await resolveCircleInfoCached(bucketId, account);
    participantCount = circleInfo?.participantCount;
  }

  const peer = resolveBasecampPeer({
    recordableType,
    recordingId,
    parentRecordingId,
    bucketId,
    isPing,
    participantCount,
  });

  const parentPeer = resolveParentPeer(bucketId, isPing);

  // Assignment detection is NOT possible from the activity feed:
  // - BC3 emits kind "todo_assignment_changed" (not _assigned/_unassigned suffixes)
  // - The activity feed's `target` field is the recording title, not the assignee name
  //   (timeline_api_event_title() falls through to event.recording.title for assignment_changed)
  // - The activity feed doesn't carry `details` (no added_person_ids)
  // Assignments are detected via: (1) webhook details.added_person_ids, (2) pollAssignments set-diff.

  const meta: BasecampInboundMeta = {
    bucketId,
    recordingId,
    recordableType,
    eventKind: resolveEventKind(raw.kind) as BasecampInboundMeta["eventKind"],
    mentions: sgids,
    mentionsAgent: isAgentMentioned,
    attachments: (raw.attachments ?? []).map((a) => ({
      sgid: a.sgid ?? "",
      url: a.url,
      contentType: a.content_type,
      filename: a.filename,
      byteSize: a.byte_size,
    })),
    sources: ["activity_feed"],
  };

  if (recordableType === "Comment" || recordableType === "Chat::Line") {
    meta.messageId = recordingId;
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
    correlationId: crypto.randomUUID(),
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

  // Unknown type → drop with metric rather than misclassifying as Document
  if (!recordableType) {
    recordUnknownKind(account.accountId, raw.type);
    return null;
  }

  const isPing = raw.type === "Ping";
  // readings participants uses other_circle_people() which excludes the caller — add 1.
  const participantCount = raw.participants ? raw.participants.length + 1 : undefined;

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

  const peer = resolveBasecampPeer({
    recordableType,
    recordingId,
    bucketId,
    isPing,
    participantCount,
  });

  const parentPeer = resolveParentPeer(bucketId, isPing);

  const meta: BasecampInboundMeta = {
    bucketId,
    recordingId,
    recordableType,
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
    correlationId: crypto.randomUUID(),
  };
}

// ---------------------------------------------------------------------------
// Assignment normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a newly-discovered assignment todo into a BasecampInboundMessage.
 *
 * Called by the assignments poller when a todo ID appears that wasn't in the
 * previous known-set. The event is always classified as an assignment directed
 * at the agent (assignedToAgent=true).
 */
export function normalizeAssignmentTodo(
  raw: BasecampAssignmentTodo,
  account: ResolvedBasecampAccount,
): BasecampInboundMessage {
  const bucketId = String(raw.bucket.id);
  const recordingId = String(raw.id);
  const text = raw.content ?? raw.title ?? "";
  const html = text;

  const sender: BasecampSender = raw.creator
    ? {
        id: String(raw.creator.id),
        name: raw.creator.name,
        email: raw.creator.email_address,
        avatarUrl: raw.creator.avatar_url,
      }
    : { id: "unknown", name: "Unknown" };

  // Use the actual type from the API response when available (e.g. "Todo",
  // "Schedule"). Fall back to "Todo" for legacy/untyped payloads.
  const recordableType: BasecampRecordableType =
    (raw.type && normalizeRecordingType(raw.type)) || "Todo";

  const peer = resolveBasecampPeer({
    recordableType,
    recordingId,
    bucketId,
  });

  const parentPeer = resolveParentPeer(bucketId, false);

  const meta: BasecampInboundMeta = {
    bucketId,
    recordingId,
    recordableType,
    eventKind: "assigned" as BasecampInboundMeta["eventKind"],
    mentions: [],
    mentionsAgent: false,
    assignedToAgent: true,
    assignees: raw.assignees?.map((a) => String(a.id)),
    attachments: [],
    dueOn: raw.due_on ?? undefined,
    sources: ["assignments"],
  };

  // Include updated_at in the dedup key so re-assignments after a previous
  // unassign→reassign cycle within the 24h TTL produce distinct keys.
  const updatedSuffix = raw.updated_at ? `:${raw.updated_at}` : "";
  const dedupPrimary = EventDedup.primaryKey("direct", `assign:${recordingId}${updatedSuffix}`);

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
    createdAt: raw.updated_at ?? raw.created_at ?? new Date().toISOString(),
    correlationId: crypto.randomUUID(),
  };
}

// ---------------------------------------------------------------------------
// Webhook normalization
// ---------------------------------------------------------------------------

export async function normalizeWebhookPayload(
  raw: BasecampWebhookPayload,
  account: ResolvedBasecampAccount,
): Promise<BasecampInboundMessage | null> {
  const recordableType = resolveRecordableType(raw.kind, raw.recording.type);

  // Unknown kind → drop with metric rather than misclassifying as Document
  if (!recordableType) {
    recordUnknownKind(account.accountId, raw.kind);
    return null;
  }

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

  // Detect Pings via bucket type. BC3 webhook recording.type is the recordable_type
  // (e.g. "Chat::Transcript"), not "Ping". The definitive signal is the bucket's
  // bucketable_type: "Circle" for Pings, "Project" for project campfires.
  const isPing = raw.recording.bucket.type === "Circle";

  // Enrich Ping participant count via Circle API (webhooks lack it)
  let participantCount: number | undefined;
  if (isPing) {
    const circleInfo = await resolveCircleInfoCached(bucketId, account);
    participantCount = circleInfo?.participantCount;
  }

  const peer = resolveBasecampPeer({
    recordableType,
    recordingId,
    parentRecordingId,
    bucketId,
    isPing,
    participantCount,
  });

  const parentPeer = resolveParentPeer(bucketId, isPing);

  const meta: BasecampInboundMeta = {
    bucketId,
    recordingId,
    recordableType,
    eventKind: resolveEventKind(raw.kind) as BasecampInboundMeta["eventKind"],
    mentions: sgids,
    mentionsAgent: isAgentMentioned,
    attachments: [],
    sources: ["webhook"],
  };

  // Detect assignment events from webhook details.
  // BC3 emits details.added_person_ids / details.removed_person_ids for
  // *_assignment_changed events (person IDs, not names).
  if (isAssignmentChangedKind(raw.kind) && raw.details) {
    const { addedPersonIds, removedPersonIds } = parseAssignmentDetails(raw.details);
    const agentPersonId = account.personId ? Number(account.personId) : undefined;

    if (addedPersonIds.length > 0) {
      meta.assignees = addedPersonIds.map(String);
    }

    if (agentPersonId != null) {
      if (addedPersonIds.includes(agentPersonId)) {
        meta.assignedToAgent = true;
      }
      // Unassignment: agent was explicitly removed from assignees.
      // classifyEngagement sees assignedToAgent=undefined; dispatch
      // can inspect meta.matchedPatterns for "unassigned_from_agent".
      if (removedPersonIds.includes(agentPersonId)) {
        meta.matchedPatterns = [...(meta.matchedPatterns ?? []), "unassigned_from_agent"];
      }
    }
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
    correlationId: crypto.randomUUID(),
  };
}
