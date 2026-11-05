import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  processCrashSink,
  type ServerFatalReport,
} from "@plugins/framework/plugins/server-core/core";
import { mountProducersForTest } from "@plugins/network/plugins/live/plugins/change-feed/server/testing";
import { processCrashHandler } from "./process-hooks";
import { reportOutboxFatalSink } from "./outbox-sink";
import { reportsProducer } from "./producer";

// The ready serving arm appends to this namespace's real crash buffer, which a
// test must not touch; the outbox arm — an exec child's, and a serving backend's
// still booting — is pinned here.
for (const mode of ["exec", "serve"] as const) {
  describe(`process-crash handler (${mode}, not ready)`, () => {
    let unmount: () => void;
    let outboxed: ServerFatalReport[];

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
          data: { errorType: "TypeError", stack: err.stack },
        },
      ]);
      expect(outboxed[0]?.message).toEndWith(": boom");
    });

    test("an unhandled rejection is named as one", () => {
      processCrashSink.emit({
        event: "unhandledRejection",
        error: new Error("later"),
      });
      expect(outboxed[0]?.message).toStartWith("Unhandled rejection in ");
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
