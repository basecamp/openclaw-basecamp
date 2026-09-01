import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = process.cwd();

/**
 * Match static import/export module specifiers. Covers:
 *   import x from "..."; import { x } from "..."; import "...";
 *   export { x } from "..."; export * from "...";
 * Dynamic `import(...)` is intentionally ignored — it does not load at
 * module-init time, which is what the setup entry contract is about.
 */
function moduleSpecifiers(source: string): string[] {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return [
    ...[...stripped.matchAll(/^\s*(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']/gm)].map((m) => m[1]),
    ...[...stripped.matchAll(/^\s*import\s*["']([^"']+)["']/gm)].map((m) => m[1]),
  ];
}

/** Resolve a relative `./x.js` specifier from a source file to its .ts path. */
function resolveRelative(fromFile: string, specifier: string): string {
  const target = resolve(dirname(fromFile), specifier.replace(/\.js$/, ".ts"));
  if (!existsSync(target)) throw new Error(`cannot resolve ${specifier} from ${fromFile}`);
  return target;
}

/** Walk the static import graph from an entry file, gathering visited files and bare specifiers. */
function walkImportGraph(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const queue = [resolve(rootDir, entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of moduleSpecifiers(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".")) {
        queue.push(resolveRelative(file, spec));
      } else {
        bare.add(spec);
      }
    }
  }
  return { files, bare };
}

// ---------------------------------------------------------------------------
// SPEC §1.4 / §4.4: the setup entry must stay import-light. The host loads it
// for read-only status/channels/SecretRef scans, so its static import graph
// must never reach the Basecamp SDK, the webhook handler, or the poller.
// ---------------------------------------------------------------------------

describe("setup-entry import graph", () => {
  const graph = walkImportGraph("setup-entry.ts");
  const visited = [...graph.files].map((f) => relative(rootDir, f)).sort();

  it("never imports @37signals/basecamp", () => {
    const offenders = [...graph.bare].filter(
      (s) => s === "@37signals/basecamp" || s.startsWith("@37signals/basecamp/"),
    );
    expect(offenders).toEqual([]);
  });

  it("never reaches the webhook handler or the poller", () => {
    expect(visited).not.toContain("src/inbound/webhooks.ts");
    expect(visited).not.toContain("src/inbound/poller.ts");
    // The full channel composition drags in both; the setup subset must not.
    expect(visited).not.toContain("src/channel.ts");
    expect(visited).not.toContain("index.ts");
  });

  it("only imports openclaw SDK subpaths, zod, and node builtins outside the repo", () => {
    const allowed = [...graph.bare].filter(
      (s) => !s.startsWith("openclaw/plugin-sdk/") && s !== "zod" && !s.startsWith("node:"),
    );
    expect(allowed).toEqual([]);
  });

  it("reaches the shared setup subset module", () => {
    expect(visited).toContain("src/channel-setup.ts");
  });
});
