/**
 * Persist poll cursors to filesystem.
 *
 * Cursors track the position of each polling source (activity feed page,
 * readings timestamp) so we can resume from where we left off after restart.
 *
 * Storage: SDK atomic JSON (SPEC §2.15) under the plugin state dir.
 * File format: cursors-<accountId>.json
 */

import { join } from "node:path";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";

export interface PollCursors {
  /** ISO timestamp of the most recent activity feed event processed. */
  activitySince?: string;
  /** ISO timestamp of the most recent reading processed. */
  readingsSince?: string;
  /** Page token for activity feed pagination (if API supports it). */
  activityPage?: string;
  /** Arbitrary per-source cursor state. */
  custom?: Record<string, string>;
}

/**
 * Manage cursor persistence for a single Basecamp account.
 */
export class CursorStore {
  private cursors: PollCursors = {};
  private dirty = false;
  private abandoned = false;
  private readonly filePath: string;

  constructor(stateDir: string, accountId: string) {
    this.filePath = join(stateDir, `cursors-${accountId}.json`);
  }

  /** Load cursors from disk. Returns empty cursors if file doesn't exist. */
  async load(): Promise<PollCursors> {
    const { value } = await readJsonFileWithFallback<PollCursors>(this.filePath, {});
    this.cursors = value;
    this.dirty = false;
    return this.cursors;
  }

  /**
   * Mark this store as abandoned. Subsequent save() calls become no-ops.
   * Used on shutdown timeout to prevent a belated background write from
   * overwriting newer cursors saved by a restarted poller instance.
   */
  abandon(): void {
    this.abandoned = true;
  }

  /** Persist cursors to disk if any changes were made (atomic replace). */
  async save(): Promise<void> {
    if (!this.dirty || this.abandoned) return;
    await writeJsonFileAtomically(this.filePath, this.cursors);
    this.dirty = false;
  }

  /** Get the current cursors (in-memory). */
  get(): PollCursors {
    return { ...this.cursors };
  }

  /** Update the activity feed cursor. Only advances forward (ISO 8601 monotonicity). */
  setActivitySince(since: string): void {
    if (this.cursors.activitySince && new Date(since) < new Date(this.cursors.activitySince)) {
      console.warn(
        `[basecamp:cursors] clock skew detected: new activitySince (${since}) < existing (${this.cursors.activitySince}), skipping`,
      );
      return;
    }
    if (this.cursors.activitySince !== since) {
      this.cursors.activitySince = since;
      this.dirty = true;
    }
  }

  /** Update the readings cursor. Only advances forward (ISO 8601 monotonicity). */
  setReadingsSince(since: string): void {
    if (this.cursors.readingsSince && new Date(since) < new Date(this.cursors.readingsSince)) {
      console.warn(
        `[basecamp:cursors] clock skew detected: new readingsSince (${since}) < existing (${this.cursors.readingsSince}), skipping`,
      );
      return;
    }
    if (this.cursors.readingsSince !== since) {
      this.cursors.readingsSince = since;
      this.dirty = true;
    }
  }

  /** Update the activity page cursor. */
  setActivityPage(page: string | undefined): void {
    if (this.cursors.activityPage !== page) {
      this.cursors.activityPage = page;
      this.dirty = true;
    }
  }

  /** Set a custom cursor value. */
  setCustom(key: string, value: string): void {
    if (!this.cursors.custom) {
      this.cursors.custom = {};
    }
    if (this.cursors.custom[key] !== value) {
      this.cursors.custom[key] = value;
      this.dirty = true;
    }
  }

  /** Get a custom cursor value. */
  getCustom(key: string): string | undefined {
    return this.cursors.custom?.[key];
  }

  /** Check if there are unsaved changes. */
  get isDirty(): boolean {
    return this.dirty;
  }
}
