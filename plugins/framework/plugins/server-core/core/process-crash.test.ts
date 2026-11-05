import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { processCrashSink } from "./process-crash";
import { onProcessCrash } from "./process-crash-listeners";
import { sinkHandler } from "./sink-handler";
import type { ProcessCrash } from "./process-crash";

// The dispatch, driven directly: installing the real listeners would take over
// the test runner's own crash handling.
describe("onProcessCrash", () => {
  let exit: Mock<typeof process.exit>;
  let error: Mock<typeof console.error>;
  let listeners: Mock<typeof process.listenerCount>;
  let filed: ProcessCrash[];
  let answer: boolean;
  const handler = sinkHandler(processCrashSink, () => (crash: ProcessCrash) => {
    filed.push(crash);
    return answer;
  });

  beforeEach(() => {
    filed = [];
    answer = true;
    exit = spyOn(process, "exit").mockImplementation((() => {}) as never);
    error = spyOn(console, "error").mockImplementation(() => {});
    // Only the framework's own listener, whatever the test runner installed.
    listeners = spyOn(process, "listenerCount").mockImplementation(() => 1);
  });

  afterEach(() => {
    handler.detach();
    exit.mockRestore();
    error.mockRestore();
    listeners.mockRestore();
  });

  test("an uncaught exception is filed through the handler, printed, then exits 1", () => {
    handler.attach();
    const err = new Error("boom");
    onProcessCrash("uncaughtException", err);
    expect(filed).toEqual([{ event: "uncaughtException", error: err }]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("a filed rejection is survived, and a non-Error reason is wrapped", () => {
    handler.attach();
    onProcessCrash("unhandledRejection", "plain reason");
    expect(filed[0]?.error.message).toBe("plain reason");
    expect(exit).not.toHaveBeenCalled();
  });

  test("a failed write says so", () => {
    handler.attach();
    answer = false;
    onProcessCrash("unhandledRejection", new Error("boom"));
    expect(String(error.mock.calls[1]?.[0])).toContain(
      "its durable write failed",
    );
    expect(exit).not.toHaveBeenCalled();
  });

  test("with no handler attached, it is not filed and exits 1 — a rejection too", () => {
    onProcessCrash("unhandledRejection", new Error("boom"));
    expect(String(error.mock.calls[1]?.[0])).toContain(
      "no handler attached to processCrashSink",
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("a handler that throws is not mistaken for none: printed, exits 1", () => {
    const throwing = sinkHandler(processCrashSink, () => () => {
      throw new Error("handler bug");
    });
    throwing.attach();
    listeners.mockImplementation(() => 2);
    try {
      onProcessCrash("uncaughtException", new Error("boom"));
    } finally {
      throwing.detach();
    }
    expect(String(error.mock.calls[1]?.[0])).toContain("its handler threw");
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("with no handler, another listener (the boot-crash filer) owns it", () => {
    listeners.mockImplementation(() => 2);
    onProcessCrash("uncaughtException", new Error("boom"));
    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
