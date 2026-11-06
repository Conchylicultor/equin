import {
  serverFatalSink,
  serverReportSink,
  sinkHandler,
} from "@plugins/framework/plugins/server-core/core";
import type { ServerReport } from "@plugins/framework/plugins/server-core/core";
import { appendFatalReportSync } from "./crash-append";
import { reportOutboxFatalSink } from "./outbox-sink";
import { reportsProducer } from "./producer";
import { recordReport } from "./record-report";

/**
 * The engine's handler on `serverReportSink` — a typed report (`reportServer`)
 * from a process that LIVES ON: a narrower jobs runner forfeited, a restart the
 * anti-loop latch suppressed. Plain `recordReport`, async: the backend keeps
 * serving, so its JS thread must not wait on a disk (the synchronous twin below
 * is for a process that exits on the spot). A failed write rejects, unhandled,
 * so the process's crash listeners print and file it — loud, never absorbed.
 */
export const serverReportHandler = sinkHandler(
  serverReportSink,
  () => (report: ServerReport) => {
    void recordReport({
      kind: report.kind,
      source: "server-caught",
      message: report.message,
      data: report.data ?? {},
    });
  },
);

/**
 * The engine's handler on `serverFatalSink` — a report filed synchronously on
 * the way out of a deliberate exit. Only server-core's `exitWithFatalReport`
 * emits it, and that exits next, so this is never reached from a process that
 * lives on. A `sinkHandlers` entry, so it is attached in every boot mode: an
 * exec child (a supervised job's body) files its fatal exit like the serving
 * backend does.
 *
 * It cannot go through `recordReport`, for the same reason the crash hooks
 * cannot: that is a Postgres write, and the caller's next statement is
 * `process.exit()`. Where it lands follows where `recordReport` would:
 *
 * - **the serving backend** (`writesHere`): one appended line in this
 *   namespace's crash buffer, replayed by `flushBufferedReports` on its next
 *   boot — the line names its own kind, so it comes back as itself instead of
 *   as an anonymous crash;
 * - **anything else** (an exec child, a CLI): one entry in the report outbox,
 *   written synchronously by `reports/outbox` and drained by main at once. Not
 *   the crash buffer: nothing flushes it until this namespace's backend next
 *   boots.
 */
export const fatalReportHandler = sinkHandler(
  serverFatalSink,
  () => fileFatalReportSync,
);

function fileFatalReportSync(report: ServerReport): boolean {
  if (reportsProducer.writesHere()) {
    const appended = appendFatalReportSync({
      kind: report.kind,
      message: report.message,
      data: report.data ?? {},
    });
    if (!appended.ok) {
      console.error(
        `[reports] could not append the "${report.kind}" fatal report to the crash buffer:`,
        appended.error,
      );
    }
    return appended.ok;
  }
  const filed = reportOutboxFatalSink.emit(report);
  if (filed === undefined) {
    console.error(
      `[reports] no outbox writer attached to reportOutboxFatalSink (reports/outbox is not in this composition) — the "${report.kind}" fatal report cannot be filed from a process that does not serve`,
    );
  }
  return filed === true;
}
