import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  reportServerFatalSync,
  type ServerFatalReport,
} from "@plugins/framework/plugins/server-core/core";
import { mountProducersForTest } from "@plugins/network/plugins/live/plugins/change-feed/server/testing";
import { fatalReportHandler } from "./fatal";
import { reportOutboxFatalSink } from "./outbox-sink";
import { reportsProducer } from "./producer";

// The serving arm appends to this namespace's real crash buffer, which a test
// must not touch; the exec arm (the one an exec child takes) is pinned here.
describe("fatal report handler (exec child)", () => {
  let unmount: () => void;
  let outboxed: ServerFatalReport[];

  beforeEach(() => {
    unmount = mountProducersForTest([reportsProducer], { mode: "exec" });
    outboxed = [];
    reportOutboxFatalSink.register((report) => {
      outboxed.push(report);
      return true;
    });
    fatalReportHandler.attach();
  });

  afterEach(() => {
    fatalReportHandler.detach();
    reportOutboxFatalSink.register(null);
    unmount();
  });

  test("files through the outbox, synchronously, before reportServerFatalSync returns", () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    reportServerFatalSync({ kind: "k", message: "exiting", data: { n: 1 } });
    expect(outboxed).toEqual([
      { kind: "k", message: "exiting", data: { n: 1 } },
    ]);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  test("says so on stderr when no outbox writer is attached", () => {
    reportOutboxFatalSink.register(null);
    const error = spyOn(console, "error").mockImplementation(() => {});
    reportServerFatalSync({ kind: "k", message: "exiting" });
    expect(error.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining("no outbox writer attached"),
      expect.stringContaining('the "k" report was NOT filed'),
    ]);
    error.mockRestore();
  });
});

test("reportServerFatalSync with no handler attached says the report was not filed", () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  reportServerFatalSync({ kind: "k", message: "exiting" });
  expect(String(error.mock.calls[0]?.[0])).toContain(
    "no handler attached to serverFatalSink",
  );
  error.mockRestore();
});
