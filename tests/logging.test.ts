import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SdkLog } from "../src/logging.js";
import { createConsoleStructuredLog, createStructuredLog } from "../src/logging.js";

describe("createStructuredLog", () => {
  let sdkLog: SdkLog;

  beforeEach(() => {
    sdkLog = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
  });

  it("formats info messages with prefix and event", () => {
    const slog = createStructuredLog(sdkLog, { accountId: "123", source: "activity" });
    slog.info("poll_dispatched");
    expect(sdkLog.info).toHaveBeenCalledWith("[basecamp:activity:123] poll_dispatched");
  });

  it("includes JSON-stringified detail", () => {
    const slog = createStructuredLog(sdkLog, { accountId: "456", source: "dispatch" });
    slog.info("dispatching", { agent: "bot-1", peer: "campfire:99" });
    expect(sdkLog.info).toHaveBeenCalledWith(
      '[basecamp:dispatch:456] dispatching {"agent":"bot-1","peer":"campfire:99"}',
    );
  });

  it("delegates warn to sdkLog.warn", () => {
    const slog = createStructuredLog(sdkLog, { accountId: "7", source: "poller" });
    slog.warn("cursor_save_failed", { error: "ENOENT" });
    expect(sdkLog.warn).toHaveBeenCalledWith('[basecamp:poller:7] cursor_save_failed {"error":"ENOENT"}');
  });

  it("delegates error to sdkLog.error", () => {
    const slog = createStructuredLog(sdkLog, { accountId: "8", source: "webhook" });
    slog.error("normalization_error", { error: "bad payload" });
    expect(sdkLog.error).toHaveBeenCalledWith('[basecamp:webhook:8] normalization_error {"error":"bad payload"}');
  });

  it("delegates debug to sdkLog.debug", () => {
    const slog = createStructuredLog(sdkLog, { accountId: "9", source: "gateway" });
    slog.debug("self_message_skipped", { personId: "42" });
    expect(sdkLog.debug).toHaveBeenCalledWith('[basecamp:gateway:9] self_message_skipped {"personId":"42"}');
  });

  it("does not throw when sdkLog is undefined (no-op)", () => {
    const slog = createStructuredLog(undefined, { accountId: "x", source: "test" });
    expect(() => slog.info("event")).not.toThrow();
    expect(() => slog.warn("event")).not.toThrow();
    expect(() => slog.error("event")).not.toThrow();
    expect(() => slog.debug("event")).not.toThrow();
  });

  it("does not throw when sdkLog.debug is undefined", () => {
    const logNoDebug: SdkLog = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const slog = createStructuredLog(logNoDebug, { accountId: "x", source: "test" });
    expect(() => slog.debug("event")).not.toThrow();
  });

  it("omits detail suffix when detail is undefined", () => {
    const slog = createStructuredLog(sdkLog, { accountId: "1", source: "poller" });
    slog.info("stopped");
    expect(sdkLog.info).toHaveBeenCalledWith("[basecamp:poller:1] stopped");
  });
});

describe("createConsoleStructuredLog", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("formats and delegates info to console.info", () => {
    const slog = createConsoleStructuredLog({ accountId: "100", source: "webhook" });
    slog.info("received", { kind: "todo_created" });
    expect(console.info).toHaveBeenCalledWith('[basecamp:webhook:100] received {"kind":"todo_created"}');
  });

  it("formats and delegates warn to console.warn", () => {
    const slog = createConsoleStructuredLog({ accountId: "200", source: "webhook" });
    slog.warn("backpressure", { queued: 5 });
    expect(console.warn).toHaveBeenCalledWith('[basecamp:webhook:200] backpressure {"queued":5}');
  });

  it("formats and delegates error to console.error", () => {
    const slog = createConsoleStructuredLog({ accountId: "300", source: "webhook" });
    slog.error("queue_full");
    expect(console.error).toHaveBeenCalledWith("[basecamp:webhook:300] queue_full");
  });

  it("formats and delegates debug to console.debug", () => {
    const slog = createConsoleStructuredLog({ accountId: "400", source: "webhook" });
    slog.debug("dedup_hit");
    expect(console.debug).toHaveBeenCalledWith("[basecamp:webhook:400] dedup_hit");
  });
});
