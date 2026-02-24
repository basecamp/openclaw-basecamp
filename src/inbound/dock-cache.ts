/**
 * Dock tool ID resolution via SDK.
 *
 * Each Basecamp project has a "dock" — a set of tools (card table, todoset,
 * questionnaire, etc.) with unique IDs. The safety net needs these IDs to
 * traverse cards, todos, and check-in questions.
 *
 * Results are cached per-project with a 1h TTL. On 404/410 from downstream
 * calls, invalidate and retry once.
 */

export interface DockToolIds {
  cardTableId?: number;
  todosetId?: number;
  questionnaireId?: number;
}

interface CacheEntry {
  ids: DockToolIds;
  fetchedAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const cache = new Map<number, CacheEntry>();

/**
 * Resolve dock tool IDs for a project.
 *
 * @param client - SDK client instance
 * @param projectId - Basecamp project (bucket) ID
 * @returns Tool IDs, or undefined if project is inaccessible
 */
export async function resolveDockToolIds(
  client: { projects: { get(id: number): Promise<any> } },
  projectId: number,
): Promise<DockToolIds | undefined> {
  const now = Date.now();
  const cached = cache.get(projectId);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.ids;
  }

  try {
    const project = await client.projects.get(projectId);
    const dock: Array<{ name: string; id: number; enabled?: boolean }> = project?.dock ?? [];

    const ids: DockToolIds = {};
    for (const item of dock) {
      if (item.name === "kanban_board" && item.enabled !== false) {
        ids.cardTableId = item.id;
      } else if (item.name === "todoset" && item.enabled !== false) {
        ids.todosetId = item.id;
      } else if (item.name === "questionnaire" && item.enabled !== false) {
        ids.questionnaireId = item.id;
      }
    }

    cache.set(projectId, { ids, fetchedAt: now });
    return ids;
  } catch {
    return undefined;
  }
}

/** Invalidate cached dock for a project. Call on 404/410 from downstream. */
export function invalidateDockCache(projectId: number): void {
  cache.delete(projectId);
}

/** Clear entire dock cache. Exported for tests. */
export function clearDockCache(): void {
  cache.clear();
}
