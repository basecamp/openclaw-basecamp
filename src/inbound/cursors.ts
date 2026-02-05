/**
 * Persist poll cursors to filesystem.
 *
 * Cursors track the position of each polling source (activity feed page,
 * readings timestamp) so we can resume from where we left off after restart.
 *
 * Storage location: resolved via runtime.state.resolveStateDir()
 * File format: cursors-<accountId>.json
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

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
  private readonly filePath: string;

  constructor(stateDir: string, accountId: string) {
    this.filePath = join(stateDir, `cursors-${accountId}.json`);
  }

  /** Load cursors from disk. Returns empty cursors if file doesn't exist. */
  async load(): Promise<PollCursors> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      this.cursors = JSON.parse(raw) as PollCursors;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.cursors = {};
      } else {
        throw err;
      }
    }
    this.dirty = false;
    return this.cursors;
  }

  /** Persist cursors to disk if any changes were made. */
  async save(): Promise<void> {
    if (!this.dirty) return;

    // Ensure directory exists
    const dir = this.filePath.substring(0, this.filePath.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });

    await writeFile(this.filePath, JSON.stringify(this.cursors, null, 2), "utf-8");
    this.dirty = false;
  }

  /** Get the current cursors (in-memory). */
  get(): PollCursors {
    return { ...this.cursors };
  }

  /** Update the activity feed cursor. */
  setActivitySince(since: string): void {
    if (this.cursors.activitySince !== since) {
      this.cursors.activitySince = since;
      this.dirty = true;
    }
  }

  /** Update the readings cursor. */
  setReadingsSince(since: string): void {
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
