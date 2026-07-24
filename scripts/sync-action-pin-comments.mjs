#!/usr/bin/env node
// Sync the trailing `# vX.Y.Z` comments on SHA-pinned `uses:` lines in
// .github/workflows with the tags each pinned SHA actually points at.
//
// Dependabot's github-actions updater rewrites SHA pins but cannot rewrite the
// version comment on lines that carry a second trailing comment (e.g. a
// `# zizmor: ignore[...]` suppression), leaving the comment stale. This script
// applies zizmor's documented rule instead: the comment token must name a tag
// that points at the pinned SHA. Everything after the token — including zizmor
// annotations — is preserved byte for byte.
//
// Zero dependencies; pure core (exported for tests) + thin I/O shell.
//
// Usage:
//   node scripts/sync-action-pin-comments.mjs           # rewrite in place
//   node scripts/sync-action-pin-comments.mjs --check   # report only; exit 1 if stale
//
// Exit codes: 0 = in sync (or successfully rewritten); 1 = --check found stale
// comments; 2 = error (resolution failure, malformed data, guard trip) — the
// tree is left untouched.

import { execFile } from "node:child_process";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

// Groups partition the whole line: prefix / action path / SHA / comment
// lead-in / version token / rest-of-line (verbatim, carries any annotations).
export const PIN_LINE_RE = /^(\s*(?:-\s+)?uses:\s+)([\w.-]+\/[\w./-]+)@([0-9a-f]{40})(\s+#\s*)(v?\d[^\s#]*)(.*)$/;

// Tags eligible as version comments: v-optional dotted numerics with an
// optional prerelease suffix.
export const TAG_RE = /^v?\d+(\.\d+){0,2}(-[0-9A-Za-z.-]+)?$/;

const LS_REMOTE_LINE_RE = /^([0-9a-f]{40})\trefs\/tags\/([^\s^]+)(\^\{\})?$/;

export class SyncError extends Error {}

/** Parse one workflow line; null if it is not a SHA-pinned uses line with a version comment. */
export function parsePinnedLine(line) {
  const m = PIN_LINE_RE.exec(line);
  if (!m) return null;
  const [, prefix, action, sha, leadIn, token, rest] = m;
  return { prefix, action, sha, leadIn, token, rest };
}

/** owner/repo for an action path, or null for paths that are not resolvable GitHub repos. */
export function repoKeyFor(action) {
  const segments = action.split("/");
  if (segments.length < 2) return null;
  const [owner, repo] = segments;
  const valid = (s) => /^[\w.-]+$/.test(s) && s !== "." && s !== "..";
  return valid(owner) && valid(repo) ? `${owner}/${repo}` : null;
}

/**
 * Parse `git ls-remote --tags` output into a Map of sha -> [tag, ...].
 * Only version-shaped tags (TAG_RE) are indexed. Peeled `^{}` entries (the
 * commit an annotated tag points at) override the tag-object sha.
 * Throws SyncError on any line that does not have the ls-remote shape.
 */
export function parseLsRemoteOutput(output) {
  const tagToSha = new Map();
  for (const line of output.split("\n")) {
    if (line === "") continue;
    const m = LS_REMOTE_LINE_RE.exec(line);
    if (!m) throw new SyncError(`malformed ls-remote line: ${JSON.stringify(line)}`);
    const [, sha, tag, peeled] = m;
    if (!TAG_RE.test(tag)) continue;
    if (peeled || !tagToSha.has(tag)) tagToSha.set(tag, sha);
  }
  const shaToTags = new Map();
  for (const [tag, sha] of tagToSha) {
    if (!shaToTags.has(sha)) shaToTags.set(sha, []);
    shaToTags.get(sha).push(tag);
  }
  return shaToTags;
}

function parseTag(tag) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(tag);
  if (!m) return null;
  const nums = [m[1], m[2], m[3]].filter((s) => s !== undefined).map(Number);
  return { nums, pre: m[4] ?? null };
}

// semver §11: dot-split identifiers; numeric-only compare numerically and rank
// below alphanumeric; alphanumeric compare lexically; equal prefix -> more
// identifiers ranks higher.
function comparePrerelease(a, b) {
  const as = a.split(".");
  const bs = b.split(".");
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    const [x, y] = [as[i], bs[i]];
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) return Number(x) - Number(y);
    if (xNum !== yNum) return xNum ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return as.length - bs.length;
}

/**
 * Order version tags for "best comment token" selection:
 *   1. stable > prerelease
 *   2. numeric comparison, segment-wise with missing segments as 0
 *   3. numerically equal: more explicit segments win (v7.0.0 > v7)
 *   4. both prerelease: semver §11 ordering
 *   5. deterministic tie-break: lexicographic tag name
 * Returns > 0 when a is the better tag.
 */
export function compareVersionTags(a, b) {
  const pa = parseTag(a);
  const pb = parseTag(b);
  if (!pa || !pb) throw new SyncError(`not a version tag: ${JSON.stringify(!pa ? a : b)}`);
  if ((pa.pre === null) !== (pb.pre === null)) return pa.pre === null ? 1 : -1;
  for (let i = 0; i < 3; i++) {
    const diff = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (pa.nums.length !== pb.nums.length) return pa.nums.length - pb.nums.length;
  if (pa.pre !== null && pb.pre !== null && pa.pre !== pb.pre) return comparePrerelease(pa.pre, pb.pre);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The best version tag from a non-empty list. */
export function chooseBestTag(tags) {
  if (!tags || tags.length === 0) throw new SyncError("chooseBestTag: no tags");
  return tags.reduce((best, tag) => (compareVersionTags(tag, best) > 0 ? tag : best));
}

/** Every unique owner/repo key referenced by pinned lines across files. */
export function collectRepoKeys(files) {
  const keys = new Set();
  for (const { content } of files) {
    for (const line of content.split("\n")) {
      const parsed = parsePinnedLine(line);
      if (!parsed) continue;
      const key = repoKeyFor(parsed.action);
      if (key) keys.add(key);
    }
  }
  return [...keys].sort();
}

/**
 * Compute all comment edits for `files` given `tagIndex` (repoKey -> Map of
 * sha -> [tags]). All-or-nothing: any unresolved repo or pinned SHA with no
 * matching tag throws SyncError and nothing is returned.
 *
 * Returns { edits, newContents } where edits is
 * [{ path, lineNo, action, sha, oldToken, newToken, oldLine, newLine }] and
 * newContents maps path -> rewritten content for files with edits.
 */
export function planEdits(files, tagIndex) {
  const edits = [];
  const newContents = new Map();
  for (const { path, content } of files) {
    const lines = content.split("\n");
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const parsed = parsePinnedLine(line);
      if (!parsed) continue;
      const key = repoKeyFor(parsed.action);
      if (!key) continue;
      const shaToTags = tagIndex.get(key);
      if (!shaToTags) throw new SyncError(`${path}:${i + 1}: no tag data for ${key}`);
      const tags = shaToTags.get(parsed.sha) ?? [];
      if (tags.includes(parsed.token)) continue;
      if (tags.length === 0) {
        throw new SyncError(`${path}:${i + 1}: no version tag points at ${key}@${parsed.sha}`);
      }
      const newToken = chooseBestTag(tags);
      if (newToken === parsed.token) continue;
      const { prefix, action, sha, leadIn, rest } = parsed;
      const rebuilt = `${prefix}${action}@${sha}${leadIn}${parsed.token}${rest}`;
      if (rebuilt !== line) throw new SyncError(`${path}:${i + 1}: parse did not partition the line exactly`);
      const newLine = `${prefix}${action}@${sha}${leadIn}${newToken}${rest}`;
      edits.push({ path, lineNo: i + 1, action, sha, oldToken: parsed.token, newToken, oldLine: line, newLine });
      lines[i] = newLine;
      changed = true;
    }
    if (changed) newContents.set(path, lines.join("\n"));
  }
  assertOnlyTokensChanged(files, newContents);
  return { edits, newContents };
}

/**
 * Guard: every difference between old and new content must be a pinned line
 * whose parse groups are identical except for the version token. Throws
 * SyncError otherwise.
 */
export function assertOnlyTokensChanged(files, newContents) {
  for (const { path, content } of files) {
    const rewritten = newContents.get(path);
    if (rewritten === undefined) continue;
    const oldLines = content.split("\n");
    const newLines = rewritten.split("\n");
    if (oldLines.length !== newLines.length) throw new SyncError(`${path}: line count changed`);
    for (let i = 0; i < oldLines.length; i++) {
      if (oldLines[i] === newLines[i]) continue;
      const before = parsePinnedLine(oldLines[i]);
      const after = parsePinnedLine(newLines[i]);
      const intact =
        before &&
        after &&
        before.prefix === after.prefix &&
        before.action === after.action &&
        before.sha === after.sha &&
        before.leadIn === after.leadIn &&
        before.rest === after.rest;
      if (!intact) throw new SyncError(`${path}:${i + 1}: change is not confined to the version token`);
    }
  }
}

// ---------------------------------------------------------------------------
// I/O shell
// ---------------------------------------------------------------------------

async function git(args, opts = {}) {
  const { stdout } = await execFileAsync("git", args, { maxBuffer: 16 * 1024 * 1024, ...opts });
  return stdout;
}

async function listWorkflowFiles(root) {
  const out = await git(
    ["ls-files", "-z", "--", ":(glob).github/workflows/*.yml", ":(glob).github/workflows/*.yaml"],
    { cwd: root },
  );
  return out
    .split("\0")
    .filter(Boolean)
    .sort()
    .filter((rel) => {
      const stat = lstatSync(join(root, rel), { throwIfNoEntry: false });
      return stat !== undefined && stat.isFile();
    });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function resolveRepoTags(repoKey) {
  let out;
  try {
    out = await git(["ls-remote", "--tags", `https://github.com/${repoKey}`]);
  } catch (error) {
    throw new SyncError(`git ls-remote failed for ${repoKey}: ${errorMessage(error)}`);
  }
  return parseLsRemoteOutput(out);
}

async function main() {
  const check = process.argv.includes("--check");
  const root = (await git(["rev-parse", "--show-toplevel"])).trim();

  const paths = await listWorkflowFiles(root);
  const files = paths.map((path) => ({ path, content: readFileSync(join(root, path), "utf8") }));

  // Phase 1: resolve every remote and compute + validate every edit. Any
  // failure aborts here with the tree untouched.
  const tagIndex = new Map();
  for (const key of collectRepoKeys(files)) {
    tagIndex.set(key, await resolveRepoTags(key));
  }
  const { edits, newContents } = planEdits(files, tagIndex);

  for (const edit of edits) {
    console.log(`${edit.path}:${edit.lineNo}: ${edit.oldToken} -> ${edit.newToken} (${edit.action}@${edit.sha})`);
  }
  if (edits.length === 0) {
    console.log("all action pin comments are in sync");
    return 0;
  }
  if (check) return 1;

  // Phase 2: write, then verify on-disk changes are confined to version tokens.
  for (const [path, content] of newContents) {
    writeFileSync(join(root, path), content);
  }
  try {
    const reread = paths.map((path) => ({
      path,
      content: files.find((f) => f.path === path).content,
      onDisk: readFileSync(join(root, path), "utf8"),
    }));
    assertOnlyTokensChanged(
      reread,
      new Map(reread.filter((f) => newContents.has(f.path)).map((f) => [f.path, f.onDisk])),
    );
  } catch (error) {
    for (const { path, content } of files) {
      if (newContents.has(path)) writeFileSync(join(root, path), content);
    }
    throw new SyncError(`post-write verification failed, original files restored: ${errorMessage(error)}`);
  }
  console.log(`updated ${edits.length} comment${edits.length === 1 ? "" : "s"}`);
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof SyncError ? `error: ${error.message}` : error);
      process.exit(2);
    },
  );
}
