import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  processCrashSink,
  type ServerReport,
} from "@plugins/framework/plugins/server-core/core";
import { mountProducersForTest } from "@plugins/network/plugins/live/plugins/change-feed/server/testing";
import {
  crashWriteLane,
  processCrashHandler,
  replayedReportInput,
} from "./process-hooks";
import { reportOutboxFatalSink } from "./outbox-sink";
import { reportsProducer } from "./producer";

// The ready serving arm appends to this namespace's real crash buffer, which a
// test must not touch; the outbox arm — an exec child's, and a serving backend's
// still booting — is pinned here.
for (const mode of ["exec", "serve"] as const) {
  describe(`process-crash handler (${mode}, not ready)`, () => {
    let unmount: () => void;
    let outboxed: ServerReport[];

    beforeEach(() => {
      unmount = mountProducersForTest([reportsProducer], { mode });
      outboxed = [];
      reportOutboxFatalSink.register((report) => {
        outboxed.push(report);
        return true;
      });
      processCrashHandler.attach();
    });

    afterEach(() => {
      processCrashHandler.detach();
      reportOutboxFatalSink.register(null);
      unmount();
    });

    test("files a crash through the outbox, synchronously", () => {
      const err = new TypeError("boom");
      expect(
        processCrashSink.emit({ event: "uncaughtException", error: err }),
      ).toBe(true);
      expect(outboxed).toEqual([
        {
          kind: "crash",
          message: expect.stringContaining("Uncaught exception in "),
          data: { errorType: "TypeError", stack: err.stack, scope: null },
        },
      ]);
      expect(outboxed[0]?.message).toEndWith(": boom");
    });

    test("an unhandled rejection is written to the outbox synchronously too, named as one", () => {
      const err = new Error("later");
      expect(
        processCrashSink.emit({ event: "unhandledRejection", error: err }),
      ).toBe(true);
      expect(outboxed).toEqual([
        {
          kind: "crash",
          message: expect.stringContaining("Unhandled rejection in "),
          data: { errorType: "Error", stack: err.stack, scope: null },
        },
      ]);
      expect(outboxed[0]?.message).toEndWith(": later");
    });

    test("a rejection answers false, saying so, when no outbox writer is attached", () => {
      reportOutboxFatalSink.register(null);
      const error = spyOn(console, "error").mockImplementation(() => {});
      expect(
        processCrashSink.emit({
          event: "unhandledRejection",
          error: new Error("later"),
        }),
      ).toBe(false);
      expect(String(error.mock.calls[0]?.[0])).toContain(
        "no outbox writer attached",
      );
      error.mockRestore();
    });

    test("answers false, saying so, when no outbox writer is attached", () => {
      reportOutboxFatalSink.register(null);
      const error = spyOn(console, "error").mockImplementation(() => {});
      expect(
        processCrashSink.emit({
          event: "uncaughtException",
          error: new Error("boom"),
        }),
      ).toBe(false);
      expect(String(error.mock.calls[0]?.[0])).toContain(
        "no outbox writer attached",
      );
      error.mockRestore();
    });
  });
}

// The one decision of where a crash is written: a synchronous write only where
// the process is dying or not serving — never on a serving backend that lives on.
describe("crashWriteLane", () => {
  test.each([
    ["uncaughtException", true, "crash-buffer-sync"],
    ["unhandledRejection", true, "record-async"],
    ["uncaughtException", false, "outbox-sync"],
    ["unhandledRejection", false, "outbox-sync"],
  ] as const)("%s, serving %p → %s", (event, serving, lane) => {
    expect(crashWriteLane(event, serving)).toBe(lane);
  });
});

describe("replayedReportInput", () => {
  const line = {
    source: "server-uncaught" as const,
    errorType: "error",
    message: "x.updated_at is derived",
    stack: "error: x\n    at a (b.ts:1:1)",
    at: "2026-11-08T17:21:05.123Z",
  };

  test("the occurrence is the writer's: its commit and its instant, not the flushing boot's", () => {
    expect(replayedReportInput({ ...line, commit: "9b06a6dcc5" })).toEqual({
      kind: "crash",
      source: "server-uncaught",
      message: "x.updated_at is derived",
      commit: "9b06a6dcc5",
      occurredAt: Date.parse("2026-11-08T17:21:05.123Z"),
      // A flat line (an older backend's) recorded no subject.
      data: {
        errorType: "error",
        stack: "error: x\n    at a (b.ts:1:1)",
        scope: null,
      },
    });
  });

  test("a writer that could not name its commit replays as null", () => {
    expect(replayedReportInput({ ...line, commit: null }).commit).toBeNull();
  });

  // `undefined` would let recordReport's stampCommit fill in THIS process's
  // pin — the replayer's code, not the code that crashed.
  test("a line from an older backend (no commit field) replays as unknown, never undefined", () => {
    expect(replayedReportInput(line).commit).toBeNull();
  });

  test("a line naming its own kind keeps its payload", () => {
    const input = replayedReportInput({
      ...line,
      source: "server-fatal",
      kind: "jobs-runner-floor",
      data: { runner: "floor" },
      commit: "abc",
    });
    expect(input.kind).toBe("jobs-runner-floor");
    expect(input.data).toEqual({ runner: "floor" });
  });

  // The buffer is unlinked before the replay: a refused line would be lost.
  test("a line with an unreadable instant is still recorded (at the flush time), and says so", () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const input = replayedReportInput({ ...line, at: "nope", commit: "abc" });
    expect(input.occurredAt).toBeUndefined();
    expect(input.commit).toBe("abc");
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("no valid `at`"),
    );
    error.mockRestore();
  });
});
