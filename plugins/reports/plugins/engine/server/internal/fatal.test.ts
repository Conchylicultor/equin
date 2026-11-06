import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  exitWithFatalReport,
  reportServer,
  type ServerReport,
} from "@plugins/framework/plugins/server-core/core";
import type { ReportInput } from "@plugins/reports/core";
import { mountProducersForTest } from "@plugins/network/plugins/live/plugins/change-feed/server/testing";
import { fatalReportHandler, serverReportHandler } from "./fatal";
import { reportOutboxFatalSink, reportOutboxSink } from "./outbox-sink";
import { reportsProducer } from "./producer";

class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}

// Stands in for `process.exit`: records the order of events and stops the
// caller the way a real exit would.
function fakeExit(log: string[]): (code: number) => never {
  return (code) => {
    log.push(`exit(${code})`);
    throw new Exited(code);
  };
}

// The serving arm appends to this namespace's real crash buffer, which a test
// must not touch; the exec arm (the one an exec child takes) is pinned here.
describe("fatal report handler (exec child)", () => {
  let unmount: () => void;
  let log: string[];
  let outboxed: ServerReport[];

  beforeEach(() => {
    unmount = mountProducersForTest([reportsProducer], { mode: "exec" });
    log = [];
    outboxed = [];
    reportOutboxFatalSink.register((report) => {
      log.push(`filed ${report.kind}`);
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

  test("files through the outbox, synchronously, then exits 1", () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      exitWithFatalReport(
        { kind: "k", message: "exiting", data: { n: 1 } },
        fakeExit(log),
      ),
    ).toThrow(Exited);
    expect(log).toEqual(["filed k", "exit(1)"]);
    expect(outboxed).toEqual([
      { kind: "k", message: "exiting", data: { n: 1 } },
    ]);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  test("says so on stderr when no outbox writer is attached, and still exits", () => {
    reportOutboxFatalSink.register(null);
    const error = spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      exitWithFatalReport({ kind: "k", message: "exiting" }, fakeExit(log)),
    ).toThrow(Exited);
    expect(error.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining("no outbox writer attached"),
      expect.stringContaining('the "k" report was NOT filed'),
    ]);
    expect(log).toEqual(["exit(1)"]);
    error.mockRestore();
  });
});

test("exitWithFatalReport with no handler attached says the report was not filed, and exits", () => {
  const log: string[] = [];
  const error = spyOn(console, "error").mockImplementation(() => {});
  expect(() =>
    exitWithFatalReport({ kind: "k", message: "exiting" }, fakeExit(log)),
  ).toThrow(Exited);
  expect(String(error.mock.calls[0]?.[0])).toContain(
    "no handler attached to serverFatalSink",
  );
  expect(log).toEqual(["exit(1)"]);
  error.mockRestore();
});

// A process that lives on files through `reportServer`: `recordReport`, never
// the synchronous fatal path. In an exec child that is the async outbox.
describe("server report handler (exec child)", () => {
  let unmount: () => void;
  let outboxed: ReportInput[];
  let fatal: ServerReport[];

  beforeEach(() => {
    unmount = mountProducersForTest([reportsProducer], { mode: "exec" });
    outboxed = [];
    fatal = [];
    reportOutboxSink.register((input) => outboxed.push(input));
    reportOutboxFatalSink.register((report) => {
      fatal.push(report);
      return true;
    });
    serverReportHandler.attach();
  });

  afterEach(() => {
    serverReportHandler.detach();
    reportOutboxSink.register(null);
    reportOutboxFatalSink.register(null);
    unmount();
  });

  test("records it asynchronously as a server-caught report of its kind", () => {
    reportServer({ kind: "k", message: "degraded", data: { n: 1 } });
    expect(outboxed).toEqual([
      expect.objectContaining({
        kind: "k",
        source: "server-caught",
        message: "degraded",
        data: { n: 1 },
      }),
    ]);
    expect(fatal).toEqual([]);
  });
});
