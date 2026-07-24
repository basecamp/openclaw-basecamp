import { describe, expect, it } from "vitest";

// @ts-expect-error -- plain .mjs module without type declarations
import {
  assertOnlyTokensChanged,
  chooseBestTag,
  collectRepoKeys,
  compareVersionTags,
  parseLsRemoteOutput,
  parsePinnedLine,
  planEdits,
  repoKeyFor,
  SyncError,
} from "../scripts/sync-action-pin-comments.mjs";

const SETUP_NODE_SHA = "820762786026740c76f36085b0efc47a31fe5020";
const CHECKOUT_SHA = "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";

// The real release.yml combined-comment line that Dependabot cannot rewrite.
const COMBINED_LINE =
  "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v6.4.0 # zizmor: ignore[cache-poisoning] -- workflow only triggers on tag push and workflow_dispatch; cache is keyed by lockfile hash and default branch";
const COMBINED_ANNOTATION =
  " # zizmor: ignore[cache-poisoning] -- workflow only triggers on tag push and workflow_dispatch; cache is keyed by lockfile hash and default branch";

/** Build a tagIndex entry: repoKey -> Map(sha -> tags). */
function index(entries: Record<string, Record<string, string[]>>) {
  return new Map(Object.entries(entries).map(([repo, shas]) => [repo, new Map(Object.entries(shas))]));
}

describe("parsePinnedLine", () => {
  it("partitions a combined-comment line, preserving the annotation verbatim", () => {
    const parsed = parsePinnedLine(COMBINED_LINE);
    expect(parsed).toEqual({
      prefix: "      - uses: ",
      action: "actions/setup-node",
      sha: SETUP_NODE_SHA,
      leadIn: " # ",
      token: "v6.4.0",
      rest: COMBINED_ANNOTATION,
    });
  });

  it("parses plain pinned lines with and without list dashes", () => {
    expect(parsePinnedLine(`        uses: actions/checkout@${CHECKOUT_SHA} # v7.0.0`)).toMatchObject({
      action: "actions/checkout",
      token: "v7.0.0",
      rest: "",
    });
    expect(parsePinnedLine(`      - uses: github/codeql-action/init@${CHECKOUT_SHA} # v3`)).toMatchObject({
      action: "github/codeql-action/init",
      token: "v3",
    });
  });

  it("skips docker refs, local actions, non-SHA refs, and comment-less pins", () => {
    expect(parsePinnedLine("      - uses: docker://alpine:3.20")).toBeNull();
    expect(parsePinnedLine("      - uses: ./local/action")).toBeNull();
    expect(parsePinnedLine("      - uses: actions/checkout@v7")).toBeNull();
    expect(parsePinnedLine(`      - uses: actions/checkout@${CHECKOUT_SHA}`)).toBeNull();
    expect(parsePinnedLine("      - run: npm ci")).toBeNull();
  });
});

describe("repoKeyFor", () => {
  it("uses the first two path segments", () => {
    expect(repoKeyFor("github/codeql-action/init")).toBe("github/codeql-action");
    expect(repoKeyFor("actions/checkout")).toBe("actions/checkout");
  });

  it("rejects dot segments and single segments", () => {
    expect(repoKeyFor("./local")).toBeNull();
    expect(repoKeyFor("../escape")).toBeNull();
    expect(repoKeyFor("bare")).toBeNull();
  });
});

describe("parseLsRemoteOutput", () => {
  it("indexes version tags by sha, preferring peeled annotated-tag targets", () => {
    const sha = CHECKOUT_SHA;
    const tagObject = "1111111111111111111111111111111111111111";
    const out = [
      `${tagObject}\trefs/tags/v7.0.0`,
      `${sha}\trefs/tags/v7.0.0^{}`,
      `${sha}\trefs/tags/v7`,
      `${sha}\trefs/tags/not-a-version`,
    ].join("\n");
    const map = parseLsRemoteOutput(out);
    expect(map.get(sha)?.sort()).toEqual(["v7", "v7.0.0"]);
    expect(map.has(tagObject)).toBe(false);
  });

  it("rejects malformed lines", () => {
    expect(() => parseLsRemoteOutput("garbage output")).toThrow(SyncError);
    expect(() => parseLsRemoteOutput(`deadbeef\trefs/tags/v1`)).toThrow(SyncError);
    expect(() => parseLsRemoteOutput(`${CHECKOUT_SHA} refs/tags/v1`)).toThrow(SyncError);
  });
});

describe("compareVersionTags / chooseBestTag", () => {
  it("prefers stable over prerelease", () => {
    expect(chooseBestTag(["v7.0.0-rc.1", "v7.0.0"])).toBe("v7.0.0");
    expect(chooseBestTag(["v8.0.0-beta.1", "v7.0.0"])).toBe("v7.0.0");
  });

  it("prefers more explicit segments among numerically equal tags", () => {
    expect(chooseBestTag(["v7", "v7.0.0"])).toBe("v7.0.0");
    expect(chooseBestTag(["v7.0.0", "v7", "v7.0"])).toBe("v7.0.0");
  });

  it("compares numerically, not lexically", () => {
    expect(chooseBestTag(["v9", "v10"])).toBe("v10");
    expect(chooseBestTag(["v1.9.0", "v1.10.0"])).toBe("v1.10.0");
  });

  it("orders prereleases per semver §11", () => {
    expect(compareVersionTags("v1.0.0-alpha", "v1.0.0-alpha.1")).toBeLessThan(0);
    expect(compareVersionTags("v1.0.0-alpha.1", "v1.0.0-alpha.beta")).toBeLessThan(0);
    expect(compareVersionTags("v1.0.0-beta.2", "v1.0.0-beta.11")).toBeLessThan(0);
    expect(compareVersionTags("v1.0.0-rc.1", "v1.0.0-beta.11")).toBeGreaterThan(0);
  });

  it("breaks exact ties deterministically and rejects non-version tags", () => {
    expect(chooseBestTag(["v1.0.0", "1.0.0"])).toBe("v1.0.0");
    expect(compareVersionTags("v1.0.0", "v1.0.0")).toBe(0);
    expect(() => compareVersionTags("v1.0.0", "nope")).toThrow(SyncError);
  });
});

describe("planEdits", () => {
  it("fixes the combined-comment line, preserving the zizmor annotation byte for byte", () => {
    const files = [{ path: ".github/workflows/release.yml", content: `${COMBINED_LINE}\n` }];
    const tagIndex = index({
      "actions/setup-node": { [SETUP_NODE_SHA]: ["v7.0.0", "v7"] },
    });
    const { edits, newContents } = planEdits(files, tagIndex);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ lineNo: 1, oldToken: "v6.4.0", newToken: "v7.0.0" });
    expect(newContents.get(".github/workflows/release.yml")).toBe(
      `      - uses: actions/setup-node@${SETUP_NODE_SHA} # v7.0.0${COMBINED_ANNOTATION}\n`,
    );
  });

  it("updates plain stale comments and leaves correct or alias comments untouched", () => {
    const content = [
      `      - uses: actions/checkout@${CHECKOUT_SHA} # v6.9.9`, // stale
      `      - uses: actions/checkout@${CHECKOUT_SHA} # v7`, // alias tag pointing at the sha
      `      - uses: actions/setup-node@${SETUP_NODE_SHA} # v7.0.0`, // already correct
      "",
    ].join("\n");
    const files = [{ path: "ci.yml", content }];
    const tagIndex = index({
      "actions/checkout": { [CHECKOUT_SHA]: ["v7", "v7.0.0"] },
      "actions/setup-node": { [SETUP_NODE_SHA]: ["v7.0.0"] },
    });
    const { edits, newContents } = planEdits(files, tagIndex);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ lineNo: 1, oldToken: "v6.9.9", newToken: "v7.0.0" });
    expect(newContents.get("ci.yml")).toBe(
      [
        `      - uses: actions/checkout@${CHECKOUT_SHA} # v7.0.0`,
        `      - uses: actions/checkout@${CHECKOUT_SHA} # v7`,
        `      - uses: actions/setup-node@${SETUP_NODE_SHA} # v7.0.0`,
        "",
      ].join("\n"),
    );
  });

  it("returns no edits when everything is in sync", () => {
    const files = [{ path: "ci.yml", content: `      - uses: actions/checkout@${CHECKOUT_SHA} # v7.0.0\n` }];
    const tagIndex = index({ "actions/checkout": { [CHECKOUT_SHA]: ["v7.0.0"] } });
    const { edits, newContents } = planEdits(files, tagIndex);
    expect(edits).toHaveLength(0);
    expect(newContents.size).toBe(0);
  });

  it("aborts the whole run when a repo is unresolvable — no partial writes", () => {
    const content = [
      `      - uses: actions/checkout@${CHECKOUT_SHA} # v6.9.9`,
      `      - uses: actions/setup-node@${SETUP_NODE_SHA} # v6.4.0`,
      "",
    ].join("\n");
    const files = [{ path: "ci.yml", content }];
    const tagIndex = index({ "actions/checkout": { [CHECKOUT_SHA]: ["v7.0.0"] } }); // setup-node missing
    expect(() => planEdits(files, tagIndex)).toThrow(/no tag data for actions\/setup-node/);
  });

  it("aborts when no version tag points at a pinned sha", () => {
    const files = [{ path: "ci.yml", content: `      - uses: actions/checkout@${CHECKOUT_SHA} # v6.9.9\n` }];
    const tagIndex = index({ "actions/checkout": { "0000000000000000000000000000000000000000": ["v7.0.0"] } });
    expect(() => planEdits(files, tagIndex)).toThrow(/no version tag points at actions\/checkout@/);
  });
});

describe("assertOnlyTokensChanged", () => {
  const original = `      - uses: actions/checkout@${CHECKOUT_SHA} # v6.9.9\n`;
  const files = [{ path: "ci.yml", content: original }];

  it("passes for a pure token substitution", () => {
    const good = new Map([["ci.yml", `      - uses: actions/checkout@${CHECKOUT_SHA} # v7.0.0\n`]]);
    expect(() => assertOnlyTokensChanged(files, good)).not.toThrow();
  });

  it("trips on any change outside the version token", () => {
    const shaChanged = new Map([
      ["ci.yml", `      - uses: actions/checkout@0000000000000000000000000000000000000000 # v7.0.0\n`],
    ]);
    expect(() => assertOnlyTokensChanged(files, shaChanged)).toThrow(/not confined to the version token/);

    const annotationDropped = new Map([["ci.yml", "      - run: echo hijacked\n"]]);
    expect(() => assertOnlyTokensChanged(files, annotationDropped)).toThrow(/not confined to the version token/);

    const lineCount = new Map([["ci.yml", `${original}extra: line\n`]]);
    expect(() => assertOnlyTokensChanged(files, lineCount)).toThrow(/line count changed/);
  });
});

describe("collectRepoKeys", () => {
  it("collects unique sorted owner/repo keys across files", () => {
    const files = [
      { path: "a.yml", content: `uses: actions/setup-node@${SETUP_NODE_SHA} # v6\nuses: docker://alpine:3.20\n` },
      {
        path: "b.yml",
        content: `uses: actions/checkout@${CHECKOUT_SHA} # v7\nuses: github/codeql-action/init@${CHECKOUT_SHA} # v3\n`,
      },
    ];
    expect(collectRepoKeys(files)).toEqual(["actions/checkout", "actions/setup-node", "github/codeql-action"]);
  });
});
