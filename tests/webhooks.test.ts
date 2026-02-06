import { describe, it, expect, vi } from "vitest";

vi.mock("../src/dispatch.js", () => ({
  dispatchBasecampEvent: vi.fn().mockResolvedValue(true),
}));
vi.mock("../src/runtime.js", () => ({
  getBasecampRuntime: vi.fn(() => ({
    config: { loadConfig: () => ({ channels: { basecamp: { accounts: { default: { personId: "1" } } } } }) },
  })),
}));
vi.mock("../src/config.js", () => ({
  resolveBasecampAccount: vi.fn(() => ({
    accountId: "default",
    enabled: true,
    personId: "1",
    token: "",
    tokenSource: "none",
    config: { personId: "1" },
  })),
}));
vi.mock("../src/inbound/normalize.js", () => ({
  normalizeWebhookPayload: vi.fn(() => ({
    channel: "basecamp",
    accountId: "default",
    peer: { kind: "group", id: "recording:1" },
    sender: { id: "2", name: "Tester" },
    text: "hi",
    html: "<p>hi</p>",
    meta: { bucketId: "1", recordingId: "1", recordableType: "Chat::Line", eventKind: "line_created", mentions: [], mentionsAgent: false, attachments: [], sources: ["webhook"] },
    dedupKey: "webhook:1",
    createdAt: "2025-01-01T00:00:00Z",
  })),
  isSelfMessage: vi.fn(() => false),
}));

import { Semaphore } from "../src/inbound/webhooks.js";

// ---------------------------------------------------------------------------
// L3: Semaphore concurrency limiter
// ---------------------------------------------------------------------------

describe("Semaphore", () => {
  it("acquires up to max concurrent", async () => {
    const sem = new Semaphore(3);

    await sem.acquire();
    await sem.acquire();
    await sem.acquire();

    // All 3 acquired, pending queue should be empty
    expect(sem.pending).toBe(0);
  });

  it("queues when at max", async () => {
    const sem = new Semaphore(2);

    await sem.acquire();
    await sem.acquire();

    // This should queue
    let resolved = false;
    const p = sem.acquire().then(() => { resolved = true; });

    // Give microtask a chance
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(sem.pending).toBe(1);

    // Release one to unblock
    sem.release();
    await p;
    expect(resolved).toBe(true);
    expect(sem.pending).toBe(0);
  });

  it("release unblocks queued in FIFO order", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];

    await sem.acquire();

    const p1 = sem.acquire().then(() => { order.push(1); });
    const p2 = sem.acquire().then(() => { order.push(2); });

    expect(sem.pending).toBe(2);

    // Release first queued
    sem.release();
    await p1;
    expect(order).toEqual([1]);

    // Release second queued
    sem.release();
    await p2;
    expect(order).toEqual([1, 2]);
  });

  it("pending count is correct through lifecycle", async () => {
    const sem = new Semaphore(1);

    expect(sem.pending).toBe(0);

    await sem.acquire();
    expect(sem.pending).toBe(0);

    const p1 = sem.acquire();
    expect(sem.pending).toBe(1);

    const p2 = sem.acquire();
    expect(sem.pending).toBe(2);

    sem.release();
    await p1;
    expect(sem.pending).toBe(1);

    sem.release();
    await p2;
    expect(sem.pending).toBe(0);
  });

  it("handles rapid acquire/release cycles", async () => {
    const sem = new Semaphore(3);

    // Rapidly acquire and release 20 times
    for (let i = 0; i < 20; i++) {
      await sem.acquire();
      sem.release();
    }

    expect(sem.pending).toBe(0);

    // Can still acquire after rapid cycling
    await sem.acquire();
    await sem.acquire();
    await sem.acquire();
    expect(sem.pending).toBe(0);

    sem.release();
    sem.release();
    sem.release();
  });
});
