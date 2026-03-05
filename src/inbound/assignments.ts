/**
 * Assignments polling source.
 *
 * Polls GET /my/assignments.json via the Basecamp API to detect todos newly assigned
 * to the service account. Uses a set-diff approach: tracks known todo IDs
 * and emits events only for new assignments.
 *
 * Unlike activity/readings pollers (timestamp cursors), this source uses
 * ID-set cursors because the API returns current state, not an event stream.
 *
 * First poll with no cursor: bootstrap — records all current IDs, emits nothing.
 * Subsequent polls: diff current vs stored — new IDs emit assignment events.
 */

import { getClient, rawOrThrow } from "../basecamp-client.js";
import type { CircuitBreaker } from "../circuit-breaker.js";
import { withCircuitBreaker } from "../retry.js";
import type { BasecampAssignmentTodo, BasecampInboundMessage, ResolvedBasecampAccount } from "../types.js";
import { normalizeAssignmentTodo } from "./normalize.js";

export interface AssignmentsPollResult {
  events: BasecampInboundMessage[];
  /** Updated set of known todo IDs (for cursor persistence). */
  knownIds: Set<string>;
}

export interface AssignmentsPollerOptions {
  account: ResolvedBasecampAccount;
  /** Previously known assignment todo IDs (from cursor). Empty set = never polled. */
  knownIds: Set<string>;
  /** True if this is the first poll (bootstrap — don't emit events). */
  isBootstrap: boolean;
  /** Circuit breaker for fail-fast on repeated API failures. */
  circuitBreaker?: { instance: CircuitBreaker; key: string };
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    debug?: (msg: string) => void;
    error: (msg: string) => void;
  };
}

/**
 * Expected response shape from GET /my/assignments.json.
 * May also be a flat array in some API versions.
 */
type AssignmentsResponse = {
  priorities?: BasecampAssignmentTodo[];
  non_priorities?: BasecampAssignmentTodo[];
};

/**
 * Flatten all assignment records from the response, recursing into children.
 * bc3's assignments API nests child assignments (e.g. todos under todolists).
 */
function flattenTodos(items: BasecampAssignmentTodo[]): BasecampAssignmentTodo[] {
  const result: BasecampAssignmentTodo[] = [];
  for (const item of items) {
    result.push(item);
    if (Array.isArray(item.children) && item.children.length > 0) {
      result.push(...flattenTodos(item.children));
    }
  }
  return result;
}

/** Extract all todos from the assignments response (handles both shapes). */
function extractTodos(data: unknown): BasecampAssignmentTodo[] {
  let items: BasecampAssignmentTodo[];
  if (Array.isArray(data)) {
    items = data as BasecampAssignmentTodo[];
  } else {
    const resp = data as AssignmentsResponse;
    items = [];
    if (Array.isArray(resp?.priorities)) {
      items.push(...resp.priorities);
    }
    if (Array.isArray(resp?.non_priorities)) {
      items.push(...resp.non_priorities);
    }
  }
  return flattenTodos(items);
}

/**
 * Poll assignments for newly-assigned todos.
 */
export async function pollAssignments(opts: AssignmentsPollerOptions): Promise<AssignmentsPollResult> {
  const { account, knownIds, isBootstrap, log } = opts;

  log?.debug?.(`[${account.accountId}] polling assignments via SDK`);

  const fetchAssignments = async () => {
    const client = getClient(account);
    return rawOrThrow(await client.raw.GET("/my/assignments.json" as any, {}));
  };

  const data = opts.circuitBreaker
    ? await withCircuitBreaker(opts.circuitBreaker.instance, opts.circuitBreaker.key, fetchAssignments)
    : await fetchAssignments();

  const todos = extractTodos(data);
  const currentIds = new Set(todos.map((t) => String(t.id)));

  log?.debug?.(`[${account.accountId}] assignments: ${currentIds.size} current, ${knownIds.size} known`);

  // Bootstrap: record all current IDs without emitting events.
  if (isBootstrap) {
    log?.info?.(`[${account.accountId}] assignments bootstrap: recording ${currentIds.size} existing assignments`);
    return { events: [], knownIds: currentIds };
  }

  // Diff: find newly-assigned todos
  const newIds = new Set<string>();
  for (const id of currentIds) {
    if (!knownIds.has(id)) {
      newIds.add(id);
    }
  }

  const events: BasecampInboundMessage[] = [];
  for (const todo of todos) {
    const todoId = String(todo.id);
    if (!newIds.has(todoId)) continue;

    try {
      const normalized = normalizeAssignmentTodo(todo, account);
      events.push(normalized);
    } catch (err) {
      log?.warn?.(`[${account.accountId}] failed to normalize assignment todo id=${todo.id}: ${String(err)}`);
    }
  }

  return { events, knownIds: currentIds };
}
