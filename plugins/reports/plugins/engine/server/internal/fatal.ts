import {
  serverFatalSink,
  sinkHandler,
} from "@plugins/framework/plugins/server-core/core";
import type { ServerFatalReport } from "@plugins/framework/plugins/server-core/core";
import { appendFatalReportSync } from "./crash-append";
import { reportOutboxFatalSink } from "./outbox-sink";
import { reportsProducer } from "./producer";

/**
 * The engine's handler on `serverFatalSink` — a report filed synchronously on
 * the way out of a deliberate exit. A `sinkHandlers` entry, so it is attached
 * in every boot mode: an exec child (a supervised job's body) files its fatal
 * exit like the serving backend does.
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

function fileFatalReportSync(report: ServerFatalReport): boolean {
  if (reportsProducer.writesHere()) {
    const appended = appendFatalReportSync({
      source: "server-fatal",
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
