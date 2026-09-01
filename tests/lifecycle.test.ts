import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/basecamp-client.js", () => ({
  clearClient: vi.fn(),
  clearClients: vi.fn(),
}));

vi.mock("../src/oauth-credentials.js", () => ({
  clearTokenManager: vi.fn(),
  resolveTokenFilePath: vi.fn((accountId: string) => `/tmp/default-tokens/${accountId}.json`),
  resolveClientFilePath: vi.fn((p: string) => p.replace(/\.json$/, ".client.json")),
}));

vi.mock("../src/inbound/webhooks.js", () => ({
  closeWebhookSecretRegistry: vi.fn(),
}));

vi.mock("../src/inbound/recording-index.js", () => ({
  closeRecordingIndex: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/config.js", () => ({
  listBasecampAccountIds: vi.fn().mockReturnValue(["kept"]),
}));

const { mockResolveStateDir } = vi.hoisted(() => ({ mockResolveStateDir: vi.fn() }));
vi.mock("../src/inbound/state-dir.js", () => ({
  resolvePluginStateDir: mockResolveStateDir,
}));

import { basecampLifecycleAdapter } from "../src/adapters/lifecycle.js";
import { clearClient } from "../src/basecamp-client.js";
import { closeRecordingIndex } from "../src/inbound/recording-index.js";
import { closeWebhookSecretRegistry } from "../src/inbound/webhooks.js";
import { clearTokenManager } from "../src/oauth-credentials.js";

function cfg(basecamp?: Record<string, unknown>) {
  return { channels: { basecamp } } as any;
}

const runtime = {} as any;

let stateDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  stateDir = mkdtempSync(join(tmpdir(), "bc-lifecycle-"));
  mockResolveStateDir.mockReturnValue(stateDir);
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// onAccountConfigChanged
// ---------------------------------------------------------------------------

describe("onAccountConfigChanged", () => {
  it("evicts cached client + token manager when token config changes", async () => {
    const prevCfg = cfg({ accounts: { test: { token: "old" } } });
    const nextCfg = cfg({ accounts: { test: { token: "new" } } });

    await basecampLifecycleAdapter.onAccountConfigChanged!({ prevCfg, nextCfg, accountId: "test", runtime });

    expect(clearTokenManager).toHaveBeenCalledWith("test");
    expect(clearClient).toHaveBeenCalledWith("test");
  });

  it("evicts when the channel-level oauth app config changes", async () => {
    const prevCfg = cfg({ accounts: { test: { oauthTokenFile: "/t.json" } }, oauth: { clientId: "a" } });
    const nextCfg = cfg({ accounts: { test: { oauthTokenFile: "/t.json" } }, oauth: { clientId: "b" } });

    await basecampLifecycleAdapter.onAccountConfigChanged!({ prevCfg, nextCfg, accountId: "test", runtime });

    expect(clearTokenManager).toHaveBeenCalledWith("test");
  });

  it("leaves caches alone when only unrelated config changes", async () => {
    const prevCfg = cfg({ accounts: { test: { token: "tok", displayName: "Old" } } });
    const nextCfg = cfg({ accounts: { test: { token: "tok", displayName: "New" } } });

    await basecampLifecycleAdapter.onAccountConfigChanged!({ prevCfg, nextCfg, accountId: "test", runtime });

    expect(clearTokenManager).not.toHaveBeenCalled();
    expect(clearClient).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// onAccountRemoved
// ---------------------------------------------------------------------------

describe("onAccountRemoved", () => {
  it("deletes cursors, webhook secrets, and recording index files", async () => {
    const files = [
      join(stateDir, "cursors-gone.json"),
      join(stateDir, "webhook-secrets-gone.json"),
      join(stateDir, "recording-index-gone.json"),
    ];
    for (const f of files) writeFileSync(f, "{}");
    const survivor = join(stateDir, "cursors-other.json");
    writeFileSync(survivor, "{}");

    await basecampLifecycleAdapter.onAccountRemoved!({ prevCfg: cfg({}), accountId: "gone", runtime });

    for (const f of files) expect(existsSync(f)).toBe(false);
    expect(existsSync(survivor)).toBe(true);
  });

  it("deletes the configured OAuth token file and its companion client file", async () => {
    const tokenFile = join(stateDir, "token.json");
    const clientFile = join(stateDir, "token.client.json");
    writeFileSync(tokenFile, "{}");
    writeFileSync(clientFile, "{}");

    const prevCfg = cfg({ accounts: { gone: { oauthTokenFile: tokenFile } } });
    await basecampLifecycleAdapter.onAccountRemoved!({ prevCfg, accountId: "gone", runtime });

    expect(existsSync(tokenFile)).toBe(false);
    expect(existsSync(clientFile)).toBe(false);
  });

  it("closes the recording index and evicts caches", async () => {
    await basecampLifecycleAdapter.onAccountRemoved!({ prevCfg: cfg({}), accountId: "gone", runtime });

    expect(closeRecordingIndex).toHaveBeenCalledWith("gone");
    expect(closeWebhookSecretRegistry).toHaveBeenCalledWith("gone");
    expect(clearTokenManager).toHaveBeenCalledWith("gone");
    expect(clearClient).toHaveBeenCalledWith("gone");
  });

  it("survives an unavailable state dir (still evicts caches)", async () => {
    mockResolveStateDir.mockImplementation(() => {
      throw new Error("runtime not initialized");
    });

    await expect(
      basecampLifecycleAdapter.onAccountRemoved!({ prevCfg: cfg({}), accountId: "gone", runtime }),
    ).resolves.toBeUndefined();

    expect(clearTokenManager).toHaveBeenCalledWith("gone");
  });
});

// ---------------------------------------------------------------------------
// runStartupMaintenance
// ---------------------------------------------------------------------------

describe("runStartupMaintenance", () => {
  it("prunes cursor files for accounts no longer configured", async () => {
    const stale = join(stateDir, "cursors-stale.json");
    const kept = join(stateDir, "cursors-kept.json");
    const unrelated = join(stateDir, "webhook-secrets-stale.json");
    writeFileSync(stale, "{}");
    writeFileSync(kept, "{}");
    writeFileSync(unrelated, "{}");

    const log = { info: vi.fn(), warn: vi.fn() };
    basecampLifecycleAdapter.runStartupMaintenance!({ cfg: cfg({}), log });
    await vi.waitFor(() => expect(existsSync(stale)).toBe(false));

    expect(existsSync(kept)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("cursors-stale.json"));
  });

  it("is a no-op when the state dir does not exist", async () => {
    rmSync(stateDir, { recursive: true, force: true });
    const log = { info: vi.fn(), warn: vi.fn() };

    expect(() => basecampLifecycleAdapter.runStartupMaintenance!({ cfg: cfg({}), log })).not.toThrow();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("is a no-op when the runtime state dir cannot be resolved", async () => {
    mockResolveStateDir.mockImplementation(() => {
      throw new Error("runtime not initialized");
    });
    const log = { info: vi.fn(), warn: vi.fn() };

    expect(() => basecampLifecycleAdapter.runStartupMaintenance!({ cfg: cfg({}), log })).not.toThrow();
  });
});
