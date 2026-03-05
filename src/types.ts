/**
 * Basecamp OpenClaw channel plugin — type definitions.
 *
 * These types model the Basecamp domain (buckets, recordings, recordables),
 * the plugin's config shape, peer conventions, and inbound/outbound message
 * structures. All other modules in the plugin import from here.
 */

// ---------------------------------------------------------------------------
// Basecamp domain primitives
// ---------------------------------------------------------------------------

/** Basecamp recordable types we track. */
export type BasecampRecordableType =
  | "Chat::Transcript"
  | "Chat::Line"
  | "Kanban::Card"
  | "Kanban::Column"
  | "Comment"
  | "Message"
  | "Todo"
  | "Todolist"
  | "Question"
  | "Question::Answer"
  | "Document"
  | "Upload"
  | "Vault"
  | "Schedule::Entry";

/**
 * Engagement types — how an event relates to the agent.
 *
 * Ordered from most specific (direct address) to most ambient:
 *   dm           — 1:1 Ping, someone is talking directly to the agent
 *   mention      — agent was @mentioned in any surface
 *   assignment   — agent was assigned/unassigned to a recording
 *   checkin      — check-in question directed at the agent (Hey! inbox)
 *   conversation — chat lines, comments in bound surfaces (not addressed)
 *   activity     — general project activity (card moves, todo completions…)
 */
export type BasecampEngagementType = "dm" | "mention" | "assignment" | "checkin" | "conversation" | "activity";

/** Default engagement types that trigger agent response. */
export const DEFAULT_ENGAGE: BasecampEngagementType[] = ["dm", "mention", "assignment", "checkin"];

/** Event kinds emitted by the composite event fabric. */
export type BasecampEventKind =
  // Chat
  | "line_created"
  | "line_edited"
  | "line_deleted"
  // Cards
  | "created"
  | "moved"
  | "assigned"
  | "comment"
  | "step_completed"
  | "sla_warning"
  // Todos
  | "completed"
  | "reopened"
  | "overdue"
  // Check-ins
  | "checkin_due"
  | "checkin_answered"
  | "checkin_paused"
  | "checkin_resumed"
  // Messages / Documents
  | "edited"
  // Direct poll
  | "disappeared"
  // Global
  | "subscription_changed"
  | "visibility_changed"
  | "archived"
  | "unarchived"
  | "trashed"
  | "untrashed"
  | "boosted";

/** Source that delivered a raw event into the fabric. */
export type BasecampEventSource =
  | "activity_feed"
  | "readings"
  | "assignments"
  | "webhook"
  | "action_cable"
  | "direct_poll";

// ---------------------------------------------------------------------------
// Peer conventions (OpenClaw-compatible)
// ---------------------------------------------------------------------------

/**
 * OpenClaw limits peer kinds to dm | group | channel. All Basecamp places
 * are mapped through these using ID conventions:
 *
 *   Campfire          → group  recording:<transcriptId>
 *   Ping (1:1)        → dm     ping:<circleBucketId>
 *   Ping (multi)      → group  ping:<circleBucketId>
 *   Card / Message / Todo / Question / Document → group recording:<id>
 *
 * parentPeer is always bucket:<bucketId> for project-level routing.
 */
export type BasecampPeerKind = "dm" | "group";

export type BasecampPeer = {
  kind: BasecampPeerKind;
  /** e.g. "recording:123", "ping:456", "bucket:789" */
  id: string;
};

// ---------------------------------------------------------------------------
// Inbound message shape
// ---------------------------------------------------------------------------

export type BasecampAttachment = {
  sgid: string;
  url?: string;
  contentType?: string;
  filename?: string;
  byteSize?: number;
};

export type BasecampSender = {
  /** Basecamp person ID (stable numeric string). */
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
};

export type BasecampInboundMeta = {
  bucketId: string;
  recordingId: string;
  recordableType: BasecampRecordableType;
  /** Child recording ID (comment or chat line). */
  messageId?: string;
  eventKind: BasecampEventKind;
  /** Person SGIDs found in bc-attachment tags. */
  mentions: string[];
  /** True when agent's own identity was @mentioned. */
  mentionsAgent: boolean;
  attachments: BasecampAttachment[];
  /** Current card column name. */
  column?: string;
  /** Previous card column name (on move). */
  columnPrevious?: string;
  /** Assigned person IDs. */
  assignees?: string[];
  /** True when agent's personId is in assignees. */
  assignedToAgent?: boolean;
  /** State marker extracted from comment text, e.g. "[APPROVED]". */
  stateMarker?: string;
  /** ISO date string for due-date-bearing recordables. */
  dueOn?: string;
  /** Which mention/keyword patterns matched. */
  matchedPatterns?: string[];
  /** Source(s) that delivered this event. */
  sources: BasecampEventSource[];
  /** True for events synthesized by direct-poll diff (safety net). */
  delta?: boolean;
};

/**
 * Normalized inbound message produced by the event fabric.
 * This is what gets handed to OpenClaw's inbound pipeline.
 */
export type BasecampInboundMessage = {
  channel: "basecamp";
  accountId: string;
  peer: BasecampPeer;
  parentPeer?: BasecampPeer;
  sender: BasecampSender;
  /** HTML → plain text extraction. */
  text: string;
  /** Original Basecamp HTML content. */
  html: string;
  meta: BasecampInboundMeta;
  /** Dedup key: eventId or composite hash. */
  dedupKey: string;
  /** ISO timestamp of the original event. */
  createdAt: string;
  /** Correlation ID for end-to-end tracing (normalize → dispatch → outbound). */
  correlationId: string;
};

// ---------------------------------------------------------------------------
// Raw Basecamp API / activity shapes
// ---------------------------------------------------------------------------

/**
 * Raw activity feed event from GET /timelines.json.
 * Shape from bc3/app/views/timelines/events/_event.json.jbuilder.
 */
export type BasecampActivityEvent = {
  id: number;
  kind: string;
  action: string;
  created_at: string;
  title?: string;
  /** Recording title from timeline_api_event_title(). For most event kinds this is the
   *  recording's own title, NOT a person name. Do not use for person identification. */
  target?: string;
  summary_excerpt?: string;
  parent_recording_id?: number;
  app_url?: string;
  bucket: {
    id: number;
    name: string;
    app_url?: string;
  };
  creator: {
    id: number;
    name: string;
    email_address?: string;
    avatar_url?: string;
    attachable_sgid?: string;
  };
  recording?: {
    id: number;
    type: string;
    recordable_type?: string;
    title?: string;
    content?: string;
  };
  attachments?: Array<{
    sgid?: string;
    url?: string;
    content_type?: string;
    filename?: string;
    byte_size?: number;
  }>;
  data?: Record<string, unknown>;
};

/**
 * Raw Hey! Readings entry from GET /my/readings.json.
 * Shape from bc3/app/views/my/readings/index.json.jbuilder.
 */
export type BasecampReadingsEntry = {
  id: number;
  created_at: string;
  updated_at?: string;
  section?: string;
  unread_count?: number;
  unread_at?: string;
  read_at?: string;
  readable_sgid?: string;
  readable_identifier?: string;
  title?: string;
  type: string;
  bucket_name?: string;
  app_url?: string;
  subscribed?: boolean;
  content_excerpt?: string;
  creator?: {
    id: number;
    name: string;
    email_address?: string;
    avatar_url?: string;
    attachable_sgid?: string;
  };
  participants?: Array<{
    id: number;
    name: string;
  }>;
  previewable_attachments?: Array<{
    sgid?: string;
    url?: string;
    content_type?: string;
  }>;
};

/**
 * Assignment event details (todo_assignment_changed, kanban_card_assignment_changed, etc.).
 * Populated by BC3 Event::Detail::PeopleChanges — person IDs, not names.
 */
export interface AssignmentChangedDetails {
  added_person_ids?: number[];
  removed_person_ids?: number[];
}

/** Webhook event details. Shape varies by event kind; known shapes are intersected. */
export type WebhookEventDetails = AssignmentChangedDetails & Record<string, unknown>;

/**
 * Raw Basecamp webhook payload.
 */
export type BasecampWebhookPayload = {
  id?: number;
  kind: string;
  created_at: string;
  /** Event-specific details. For assignment events: { added_person_ids, removed_person_ids }. */
  details?: WebhookEventDetails;
  recording: {
    id: number;
    type: string;
    title?: string;
    content?: string;
    parent?: {
      id: number;
      type: string;
    };
    bucket: {
      id: number;
      name: string;
      /** Bucket type from bucketable_type. "Circle" for Pings, "Project" for projects. */
      type?: string;
    };
  };
  creator: {
    id: number;
    name: string;
    email_address?: string;
    attachable_sgid?: string;
  };
  delivery?: {
    id: number;
    webhook_url: string;
  };
};

/**
 * Raw todo entry from GET /my/assignments.json.
 * The response is `{ priorities: Todo[], non_priorities: Todo[] }`.
 * Each todo represents a currently-assigned (incomplete) task.
 */
export type BasecampAssignmentTodo = {
  id: number;
  content?: string;
  title?: string;
  app_url?: string;
  starts_on?: string | null;
  due_on?: string | null;
  completed?: boolean;
  created_at?: string;
  updated_at?: string;
  /** Recordable type name from short_recordable_name(), e.g. "Todo", "Schedule". */
  type?: string;
  bucket: {
    id: number;
    name: string;
    app_url?: string;
  };
  assignees?: Array<{
    id: number;
    name: string;
    avatar_url?: string;
  }>;
  creator?: {
    id: number;
    name: string;
    email_address?: string;
    avatar_url?: string;
  };
  parent?: {
    id: number;
    title?: string;
    app_url?: string;
  };
  /** Nested child assignments (recursive). */
  children?: BasecampAssignmentTodo[];
};

// ---------------------------------------------------------------------------
// Raw API entity shapes (for directory / resolver adapters)
// ---------------------------------------------------------------------------

export type BasecampPerson = {
  id: number;
  name: string;
  email_address: string;
  avatar_url?: string;
  attachable_sgid?: string;
};

export type BasecampProject = {
  id: number;
  name: string;
  description?: string;
  app_url?: string;
  bookmarked?: boolean;
};

// ---------------------------------------------------------------------------
// Per-bucket config (Group C)
// ---------------------------------------------------------------------------

export type BasecampBucketConfig = {
  requireMention?: boolean;
  tools?: { allow?: string[]; deny?: string[] };
  enabled?: boolean;
  /** Override engagement types for this bucket. */
  engage?: BasecampEngagementType[];
  /** Sender person IDs allowed to trigger the agent in this bucket. Unset = all senders. */
  allowFrom?: Array<string | number>;
};

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

/**
 * Per-account config stored in channels.basecamp.accounts.<accountId>.
 * Each account represents a Basecamp service-account identity.
 */
export type BasecampAccountConfig = {
  /** Path to a file containing the OAuth/bearer token. */
  tokenFile?: string;
  /** Inline token (prefer tokenFile for security). */
  token?: string;
  /** Basecamp person ID for this service account. */
  personId: string;
  /** Human-readable display name. */
  displayName?: string;
  /** Pre-resolved attachable SGID (auto-resolved at startup if absent). */
  attachableSgid?: string;
  /** Whether this account is enabled. */
  enabled?: boolean;
  /**
   * CLI profile name for this account (maps to --profile flag).
   * Selects which CLI credential/config profile to use.
   * Omit to use the CLI's default profile.
   */
  cliProfile?: string;
  /** Numeric Basecamp account ID for SDK client creation. */
  basecampAccountId?: string;
  /** Path to file where OAuth tokens are stored. Presence implies tokenSource "oauth". */
  oauthTokenFile?: string;
  /** Per-account OAuth client ID override. */
  oauthClientId?: string;
  /** Per-account OAuth client secret override. */
  oauthClientSecret?: string;
};

/**
 * Virtual account alias — maps a synthetic account ID to a specific
 * bucket on a real account. Used for per-project routing without parentPeer.
 */
export type BasecampVirtualAccountConfig = {
  accountId: string;
  bucketId: string;
};

/**
 * Top-level channels.basecamp config section.
 */
export type BasecampChannelConfig = {
  enabled?: boolean;
  accounts?: Record<string, BasecampAccountConfig>;
  virtualAccounts?: Record<string, BasecampVirtualAccountConfig>;
  /** Agent ID → account ID mapping for multi-persona outbound. */
  personas?: Record<string, string>;
  /**
   * DM policy for Ping conversations.
   * Uses the SDK's standard vocabulary:
   *   pairing  — DMs allowed through the pairing flow (default)
   *   allowlist — DMs allowed only from sender IDs in allowFrom
   *   open     — DMs allowed from anyone
   *   disabled — DMs completely blocked
   */
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  /** Allowed sender person IDs for DM/pairing. */
  allowFrom?: Array<string | number>;
  /** Per-bucket behavior overrides. Key is bucket ID or "*" for wildcard. */
  buckets?: Record<string, BasecampBucketConfig>;
  /**
   * Engagement types that trigger agent response.
   * Defaults to ["dm", "mention", "assignment", "checkin"].
   * Per-bucket overrides in `buckets.<id>.engage` take precedence.
   */
  engage?: BasecampEngagementType[];
  /** Secret token for webhook URL verification. Webhook requests are rejected when unset. */
  webhookSecret?: string;
  /** Webhook subscription management. */
  webhooks?: {
    /** HTTPS URL where Basecamp sends webhook payloads. Required for auto-registration. */
    payloadUrl?: string;
    /** Bucket IDs to create webhooks for. Omit for manual-only management. */
    projects?: string[];
    /** Recordable types to subscribe to. Defaults to all types. */
    types?: string[];
    /** Auto-register webhooks on gateway startup. Default: true. */
    autoRegister?: boolean;
    /** Deactivate webhooks on gateway shutdown. Default: false. */
    deactivateOnStop?: boolean;
  };
  /** Channel-level OAuth client credentials (shared across accounts). */
  oauth?: {
    clientId: string;
    clientSecret?: string;
  };
  /** Polling cadence overrides (milliseconds). */
  polling?: {
    activityIntervalMs?: number;
    readingsIntervalMs?: number;
    assignmentsIntervalMs?: number;
  };
  /** Retry options for API calls. */
  retry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitter?: boolean;
  };
  /** Circuit breaker options for API calls. */
  circuitBreaker?: {
    threshold?: number;
    cooldownMs?: number;
  };
  /** Safety net direct-polling config. */
  safetyNet?: {
    projects?: string[];
    intervalMs?: number;
  };
  /** Reconciliation pass config. */
  reconciliation?: {
    enabled?: boolean;
    intervalMs?: number;
    gapThreshold?: number;
  };
};

/**
 * Resolved account with all config merged and token loaded.
 * This is the ResolvedAccount type parameter for ChannelPlugin<>.
 */
export type ResolvedBasecampAccount = {
  accountId: string;
  enabled: boolean;
  displayName?: string;
  personId: string;
  attachableSgid?: string;
  token: string;
  tokenSource: "tokenFile" | "config" | "oauth" | "none";
  /** OAuth client ID (from per-account or channel-level config). */
  oauthClientId?: string;
  /** OAuth client secret (from per-account or channel-level config). */
  oauthClientSecret?: string;
  /** CLI profile name (for --profile flag). */
  cliProfile?: string;
  /** When this account was resolved via a project-scope entry, the scoped bucket ID. */
  scopedBucketId?: string;
  config: BasecampAccountConfig;
};

// ---------------------------------------------------------------------------
// Outbound types
// ---------------------------------------------------------------------------

/** Target types for outbound messages. */
export type BasecampOutboundTargetType =
  | "campfire"
  | "ping"
  | "comment"
  | "card_create"
  | "card_move"
  | "todo_complete";

export type BasecampOutboundResult = {
  channel: "basecamp";
  messageId?: string;
  recordingId?: string;
  ok: boolean;
  error?: string;
};

// ---------------------------------------------------------------------------
// Dedup types
// ---------------------------------------------------------------------------

export type DedupEntry = {
  dedupKey: string;
  accountId: string;
  processedAt: string;
};

// ---------------------------------------------------------------------------
// Polling cursor state
// ---------------------------------------------------------------------------

export type BasecampPollingCursors = {
  /** Last activity feed event ID seen. */
  activityLastId?: number;
  /** Last activity feed event timestamp. */
  activityLastAt?: string;
  /** Last readings entry ID seen. */
  readingsLastId?: number;
  /** Last readings entry timestamp. */
  readingsLastAt?: string;
};

// ---------------------------------------------------------------------------
// Column → state mapping
// ---------------------------------------------------------------------------

export type BasecampWorkState = "INBOX" | "WORKING" | "PROPOSED" | "APPROVED" | "EXECUTED" | "CLOSED";

export type ColumnStateMap = Record<string, Record<string, BasecampWorkState>>;
