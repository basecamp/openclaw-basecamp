/**
 * Safety net polling source — direct API traversal for delta detection.
 *
 * Polls configured projects for cards, todos, and check-in answers via
 * the Basecamp SDK. Compares against stored snapshots to detect:
 *   - appeared: new items not in previous snapshot
 *   - moved: cards whose column changed
 *   - disappeared: items missing for 2 consecutive deep crawl cycles
 *   - checkin_answered: increased answer count on a question
 *
 * Two cycle modes:
 *   - Capped (normal): maxItems=50, first-page only. Detects appeared/changed.
 *   - Deep (every 6th cycle): no cap, full traversal. Enables disappeared detection.
 */

import crypto from "node:crypto";
import { BasecampError } from "../basecamp-client.js";
import type {
  BasecampEventKind,
  BasecampInboundMessage,
  BasecampInboundMeta,
  BasecampRecordableType,
  ResolvedBasecampAccount,
} from "../types.js";
import { EventDedup } from "./dedup.js";
import { invalidateDockCache, resolveDockToolIds } from "./dock-cache.js";

function isStaleResourceError(err: unknown): boolean {
  if (err instanceof BasecampError) {
    return err.httpStatus === 404 || err.httpStatus === 410 || err.code === "not_found";
  }
  return false;
}

// ---------------------------------------------------------------------------
// Snapshot types
// ---------------------------------------------------------------------------

export interface CardSnapshot {
  columnId: number;
  columnName: string;
  updatedAt: string;
  /** Person IDs currently assigned to this card. */
  assignees: string[];
}

export interface TodoSnapshot {
  updatedAt: string;
  /** Person IDs currently assigned to this todo. */
  assignees: string[];
}

export interface CheckinSnapshot {
  /** Individual answer IDs seen for this question. */
  answerIds: string[];
}

export interface ProjectSnapshot {
  cards: Record<string, CardSnapshot>;
  todos: Record<string, TodoSnapshot>;
  checkins: Record<string, CheckinSnapshot>;
}

export interface SafetyNetSnapshot {
  version: 1;
  updatedAt: string;
  projects: Record<string, ProjectSnapshot>;
}

/** Tracks items pending disappeared confirmation (need 2 deep crawl misses). */
export interface DisappearedPending {
  /** Map of "type:id" → number of consecutive deep-crawl misses. */
  entries: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface SafetyNetPollResult {
  events: BasecampInboundMessage[];
  snapshot: SafetyNetSnapshot;
  pending: DisappearedPending;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function changeHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 8);
}

function buildDeltaMessage(opts: {
  accountId: string;
  projectId: number;
  recordingId: string;
  recordableType: BasecampRecordableType;
  eventKind: BasecampEventKind;
  text: string;
  dedupKey: string;
  createdAt: string;
  extraMeta?: Partial<BasecampInboundMeta>;
}): BasecampInboundMessage {
  return {
    channel: "basecamp",
    accountId: opts.accountId,
    peer: { kind: "group", id: `recording:${opts.recordingId}` },
    parentPeer: { kind: "group", id: `bucket:${opts.projectId}` },
    sender: { id: "system", name: "Safety Net" },
    text: opts.text,
    html: "",
    meta: {
      bucketId: String(opts.projectId),
      recordingId: opts.recordingId,
      recordableType: opts.recordableType,
      eventKind: opts.eventKind,
      mentions: [],
      mentionsAgent: false,
      attachments: [],
      sources: ["direct_poll"],
      delta: true,
      ...opts.extraMeta,
    },
    dedupKey: opts.dedupKey,
    createdAt: opts.createdAt,
    correlationId: crypto.randomUUID(),
  };
}

// ---------------------------------------------------------------------------
// Core poll function
// ---------------------------------------------------------------------------

export interface SafetyNetPollOptions {
  account: ResolvedBasecampAccount;
  client: any; // SDK client
  projectIds: number[];
  previousSnapshot: SafetyNetSnapshot | undefined;
  previousPending: DisappearedPending | undefined;
  isDeepCrawl: boolean;
  maxItems?: number;
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    debug?: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export async function pollSafetyNet(opts: SafetyNetPollOptions): Promise<SafetyNetPollResult> {
  const { account, client, projectIds, previousSnapshot, isDeepCrawl, log } = opts;
  const maxItems = isDeepCrawl ? undefined : (opts.maxItems ?? 50);
  const events: BasecampInboundMessage[] = [];

  const newSnapshot: SafetyNetSnapshot = {
    version: 1,
    updatedAt: new Date().toISOString(),
    projects: {},
  };

  const pending: DisappearedPending = {
    entries: { ...(opts.previousPending?.entries ?? {}) },
  };

  for (const projectId of projectIds) {
    const dockIds = await resolveDockToolIds(client, projectId);
    const prevProject = previousSnapshot?.projects[String(projectId)];
    if (!dockIds) {
      log?.warn?.(`[${account.accountId}] safety_net: project ${projectId} dock inaccessible, skipping`);
      // Carry forward previous snapshot to avoid state loss on transient failures
      if (prevProject) newSnapshot.projects[String(projectId)] = prevProject;
      continue;
    }

    const projectSnap: ProjectSnapshot = {
      cards: {},
      todos: {},
      checkins: {},
    };

    // --- Cards ---
    if (dockIds.cardTableId != null) {
      try {
        const cardSnap = await crawlCards(client, projectId, dockIds.cardTableId, maxItems);
        projectSnap.cards = cardSnap.cards;

        if (prevProject) {
          // Detect appeared / moved / assignment changes
          for (const [cardId, card] of Object.entries(cardSnap.cards)) {
            const prev = prevProject.cards[cardId];
            if (!prev) {
              // Appeared
              const hash = changeHash(`appeared:${cardId}`);
              events.push(
                buildDeltaMessage({
                  accountId: account.accountId,
                  projectId,
                  recordingId: cardId,
                  recordableType: "Kanban::Card",
                  eventKind: "created",
                  text: `Card ${cardId} appeared in ${card.columnName}`,
                  dedupKey: `direct:card:${cardId}:${hash}`,
                  createdAt: card.updatedAt,
                  extraMeta: { column: card.columnName, assignees: card.assignees },
                }),
              );
            } else {
              if (prev.columnId !== card.columnId) {
                // Moved
                const hash = changeHash(`moved:${cardId}:${prev.columnId}:${card.columnId}`);
                events.push(
                  buildDeltaMessage({
                    accountId: account.accountId,
                    projectId,
                    recordingId: cardId,
                    recordableType: "Kanban::Card",
                    eventKind: "moved",
                    text: `Card ${cardId} moved from ${prev.columnName} to ${card.columnName}`,
                    dedupKey: `direct:card:${cardId}:${hash}`,
                    createdAt: card.updatedAt,
                    extraMeta: { column: card.columnName, columnPrevious: prev.columnName },
                  }),
                );
              }
              // Assignment diff
              const added = card.assignees.filter((a) => !prev.assignees.includes(a));
              const removed = prev.assignees.filter((a) => !card.assignees.includes(a));
              if (added.length > 0 || removed.length > 0) {
                const hash = changeHash(`assign:${cardId}:${card.assignees.sort().join(",")}`);
                const agentAssigned = account.personId ? added.includes(account.personId) : false;
                events.push(
                  buildDeltaMessage({
                    accountId: account.accountId,
                    projectId,
                    recordingId: cardId,
                    recordableType: "Kanban::Card",
                    eventKind: "assigned",
                    text: `Card ${cardId} assignees changed: +${added.length} -${removed.length}`,
                    dedupKey: `direct:card:${cardId}:${hash}`,
                    createdAt: card.updatedAt,
                    extraMeta: {
                      assignees: card.assignees,
                      assignedToAgent: agentAssigned || undefined,
                    },
                  }),
                );
              }
            }
          }

          // Detect disappeared (deep crawl only, non-truncated)
          if (isDeepCrawl && !cardSnap.truncated) {
            for (const cardId of Object.keys(prevProject.cards)) {
              if (!cardSnap.cards[cardId]) {
                const pendingKey = `card:${cardId}`;
                pending.entries[pendingKey] = (pending.entries[pendingKey] ?? 0) + 1;
                if (pending.entries[pendingKey] >= 2) {
                  const hash = changeHash(`disappeared:${cardId}`);
                  events.push(
                    buildDeltaMessage({
                      accountId: account.accountId,
                      projectId,
                      recordingId: cardId,
                      recordableType: "Kanban::Card",
                      eventKind: "disappeared",
                      text: `Card ${cardId} disappeared`,
                      dedupKey: `direct:card:${cardId}:${hash}`,
                      createdAt: new Date().toISOString(),
                    }),
                  );
                  delete pending.entries[pendingKey];
                }
              } else {
                // Still present — reset pending counter
                delete pending.entries[`card:${cardId}`];
              }
            }
          }
        }
      } catch (err) {
        if (isStaleResourceError(err)) invalidateDockCache(projectId);
        // Carry forward previous cards to avoid false "appeared" bursts on recovery
        if (prevProject) projectSnap.cards = prevProject.cards;
        log?.warn?.(`[${account.accountId}] safety_net: cards crawl failed for project ${projectId}: ${String(err)}`);
      }
    }

    // --- Todos ---
    if (dockIds.todosetId != null) {
      try {
        const todoSnap = await crawlTodos(client, projectId, maxItems);
        projectSnap.todos = todoSnap.todos;

        if (prevProject) {
          for (const [todoId, todo] of Object.entries(todoSnap.todos)) {
            const prev = prevProject.todos[todoId];
            if (!prev) {
              const hash = changeHash(`appeared:${todoId}`);
              events.push(
                buildDeltaMessage({
                  accountId: account.accountId,
                  projectId,
                  recordingId: todoId,
                  recordableType: "Todo",
                  eventKind: "created",
                  text: `Todo ${todoId} appeared`,
                  dedupKey: `direct:todo:${todoId}:${hash}`,
                  createdAt: todo.updatedAt,
                  extraMeta: { assignees: todo.assignees },
                }),
              );
            } else {
              // Assignment diff
              const added = todo.assignees.filter((a) => !prev.assignees.includes(a));
              const removed = prev.assignees.filter((a) => !todo.assignees.includes(a));
              if (added.length > 0 || removed.length > 0) {
                const hash = changeHash(`assign:${todoId}:${todo.assignees.sort().join(",")}`);
                const agentAssigned = account.personId ? added.includes(account.personId) : false;
                events.push(
                  buildDeltaMessage({
                    accountId: account.accountId,
                    projectId,
                    recordingId: todoId,
                    recordableType: "Todo",
                    eventKind: "assigned",
                    text: `Todo ${todoId} assignees changed: +${added.length} -${removed.length}`,
                    dedupKey: `direct:todo:${todoId}:${hash}`,
                    createdAt: todo.updatedAt,
                    extraMeta: {
                      assignees: todo.assignees,
                      assignedToAgent: agentAssigned || undefined,
                    },
                  }),
                );
              }
            }
          }

          if (isDeepCrawl && !todoSnap.truncated) {
            for (const todoId of Object.keys(prevProject.todos)) {
              if (!todoSnap.todos[todoId]) {
                const pendingKey = `todo:${todoId}`;
                pending.entries[pendingKey] = (pending.entries[pendingKey] ?? 0) + 1;
                if (pending.entries[pendingKey] >= 2) {
                  const hash = changeHash(`disappeared:${todoId}`);
                  events.push(
                    buildDeltaMessage({
                      accountId: account.accountId,
                      projectId,
                      recordingId: todoId,
                      recordableType: "Todo",
                      eventKind: "disappeared",
                      text: `Todo ${todoId} disappeared`,
                      dedupKey: `direct:todo:${todoId}:${hash}`,
                      createdAt: new Date().toISOString(),
                    }),
                  );
                  delete pending.entries[pendingKey];
                }
              } else {
                delete pending.entries[`todo:${todoId}`];
              }
            }
          }
        }
      } catch (err) {
        if (isStaleResourceError(err)) invalidateDockCache(projectId);
        if (prevProject) projectSnap.todos = prevProject.todos;
        log?.warn?.(`[${account.accountId}] safety_net: todos crawl failed for project ${projectId}: ${String(err)}`);
      }
    }

    // --- Check-ins ---
    if (dockIds.questionnaireId != null) {
      try {
        const checkinSnap = await crawlCheckins(client, projectId, dockIds.questionnaireId);
        projectSnap.checkins = checkinSnap.checkins;

        if (prevProject) {
          for (const [questionId, q] of Object.entries(checkinSnap.checkins)) {
            const prev = prevProject.checkins[questionId];
            if (prev) {
              const prevSet = new Set(prev.answerIds);
              const newAnswerIds = q.answerIds.filter((id) => !prevSet.has(id));
              for (const answerId of newAnswerIds) {
                events.push(
                  buildDeltaMessage({
                    accountId: account.accountId,
                    projectId,
                    recordingId: answerId,
                    recordableType: "Question::Answer",
                    eventKind: "checkin_answered",
                    text: `New answer ${answerId} to check-in question ${questionId}`,
                    dedupKey: `direct:answer:${answerId}`,
                    createdAt: new Date().toISOString(),
                  }),
                );
              }
            }
          }
        }
      } catch (err) {
        if (isStaleResourceError(err)) invalidateDockCache(projectId);
        if (prevProject) projectSnap.checkins = prevProject.checkins;
        log?.warn?.(
          `[${account.accountId}] safety_net: checkins crawl failed for project ${projectId}: ${String(err)}`,
        );
      }
    }

    newSnapshot.projects[String(projectId)] = projectSnap;
  }

  return { events, snapshot: newSnapshot, pending };
}

// ---------------------------------------------------------------------------
// Resource crawlers
// ---------------------------------------------------------------------------

interface CardCrawlResult {
  cards: Record<string, CardSnapshot>;
  truncated: boolean;
}

async function crawlCards(
  client: any,
  projectId: number,
  cardTableId: number,
  maxItems?: number,
): Promise<CardCrawlResult> {
  const cards: Record<string, CardSnapshot> = {};
  let truncated = false;

  // Get card table to discover columns
  const table = await client.cardTables.get(projectId, cardTableId);
  const columns: Array<{ id: number; title: string }> = table?.lists ?? [];

  for (const col of columns) {
    const listOpts: any = {};
    if (maxItems != null) listOpts.maxItems = maxItems;
    const result = await client.cards.list(projectId, col.id, listOpts);
    const items: any[] = Array.isArray(result) ? result : (result?.data ?? []);

    if (result?.meta?.truncated) truncated = true;

    for (const card of items) {
      const assignees: string[] = Array.isArray(card.assignees) ? card.assignees.map((a: any) => String(a.id)) : [];
      cards[String(card.id)] = {
        columnId: col.id,
        columnName: col.title,
        updatedAt: card.updated_at ?? new Date().toISOString(),
        assignees,
      };
    }
  }

  return { cards, truncated };
}

interface TodoCrawlResult {
  todos: Record<string, TodoSnapshot>;
  truncated: boolean;
}

async function crawlTodos(client: any, projectId: number, maxItems?: number): Promise<TodoCrawlResult> {
  const todos: Record<string, TodoSnapshot> = {};
  let truncated = false;

  const listOpts: any = { bucket: [projectId] };
  if (maxItems != null) listOpts.maxItems = maxItems;

  const result = await client.recordings.list("Todo", listOpts);
  const items: any[] = Array.isArray(result) ? result : (result?.data ?? []);

  if (result?.meta?.truncated) truncated = true;

  for (const todo of items) {
    const assignees: string[] = Array.isArray(todo.assignees) ? todo.assignees.map((a: any) => String(a.id)) : [];
    todos[String(todo.id)] = {
      updatedAt: todo.updated_at ?? new Date().toISOString(),
      assignees,
    };
  }

  return { todos, truncated };
}

interface CheckinCrawlResult {
  checkins: Record<string, CheckinSnapshot>;
}

async function crawlCheckins(client: any, projectId: number, questionnaireId: number): Promise<CheckinCrawlResult> {
  const checkins: Record<string, CheckinSnapshot> = {};

  const questions = await client.checkins.listQuestions(projectId, questionnaireId);
  const qItems: any[] = Array.isArray(questions) ? questions : (questions?.data ?? []);

  for (const q of qItems) {
    const questionId = String(q.id);
    // Fetch individual answers to get their IDs for cross-source dedup
    let answerIds: string[] = [];
    try {
      const answers = await client.checkins.listAnswers(projectId, Number(questionId));
      const aItems: any[] = Array.isArray(answers) ? answers : (answers?.data ?? []);
      answerIds = aItems.map((a: any) => String(a.id));
    } catch {
      // Fall back to empty — we'll detect new answers next cycle
    }
    checkins[questionId] = { answerIds };
  }

  return { checkins };
}

// ---------------------------------------------------------------------------
// Snapshot serialization
// ---------------------------------------------------------------------------

export function serializeSnapshot(snap: SafetyNetSnapshot): string {
  return JSON.stringify(snap);
}

export function deserializeSnapshot(raw: string): SafetyNetSnapshot | undefined {
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1) return undefined;
    return parsed as SafetyNetSnapshot;
  } catch {
    return undefined;
  }
}

export function serializePending(pending: DisappearedPending): string {
  return JSON.stringify(pending);
}

export function deserializePending(raw: string): DisappearedPending | undefined {
  try {
    return JSON.parse(raw) as DisappearedPending;
  } catch {
    return undefined;
  }
}
