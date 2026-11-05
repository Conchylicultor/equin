import {
  isServerReady,
  processCrashSink,
  sinkHandler,
} from "@plugins/framework/plugins/server-core/core";
import type { ProcessCrash } from "@plugins/framework/plugins/server-core/core";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import type { ReportSource } from "@plugins/reports/core";
import { appendReportSync, readAndClearBuffer } from "./buffer";
import { reportOutboxFatalSink } from "./outbox-sink";
import { reportsProducer } from "./producer";
import { recordReport } from "./record-report";

/**
 * The engine's handler on `processCrashSink` — an uncaught exception or an
 * unhandled rejection the process's own listeners caught (server-core installs
 * them at each process entry point, in every boot mode). A `sinkHandlers`
 * entry, so it is attached in an exec child too: a supervised job's body that
 * crashes outside its await chain is filed like the serving backend's crash.
 *
 * Synchronous for the same reason as the fatal handler (./fatal.ts): an
 * uncaught exception exits on the listener's next statement, so the write is a
 * file, never Postgres. Where it lands follows where `recordReport` would:
 *
 * - **the serving backend, once ready**: one line in this namespace's crash
 *   buffer, replayed by `flushBufferedReports` on its next boot (and at once,
 *   for a rejection the process survives);
 * - **anything else** — an exec child, a CLI, or a serving backend still
 *   booting (its next boot may crash at the same point, before it flushes):
 *   one entry in the report outbox, written synchronously, drained by main.
 */
export const processCrashHandler = sinkHandler(
  processCrashSink,
  () => fileProcessCrashSync,
);

function fileProcessCrashSync({ event, error }: ProcessCrash): boolean {
  const source: ReportSource =
    event === "uncaughtException" ? "server-uncaught" : "server-unhandled";
  if (reportsProducer.writesHere() && isServerReady()) {
    const appended = appendReportSync(source, error);
    if (!appended.ok) {
      console.error(
        `[reports] could not append the ${event} to the crash buffer:`,
        appended.error,
      );
      return false;
    }
    if (event === "unhandledRejection") {
      // The process survives a rejection, so the line need not wait for the
      // next boot.
      // eslint-disable-next-line promise-safety/no-bare-catch, detached-work-safety/no-untracked-detached-work -- observability flush: drains buffered reports on unhandledRejection; must stay profiler-invisible
      void flushBufferedReports().catch((err) => {
        console.error(
          "[reports] flushBufferedReports failed in the unhandledRejection handler",
          err,
        );
      });
    }
    return true;
  }
  const what =
    event === "uncaughtException"
      ? "Uncaught exception"
      : "Unhandled rejection";
  const where = reportsProducer.writesHere()
    ? "the booting backend"
    : "a background process (exec child or CLI)";
  const filed = reportOutboxFatalSink.emit({
    kind: "crash",
    message: `${what} in ${where} of ${runtimeNamespace()}: ${error.message}`,
    data: { errorType: error.name, stack: error.stack ?? null },
  });
  if (filed === undefined) {
    console.error(
      `[reports] no outbox writer attached to reportOutboxFatalSink (reports/outbox is not in this composition, or has not reached its onReadyBlocking) — the ${event} cannot be filed from this process`,
    );
  }
  return filed === true;
}

// Read the JSONL buffer and run each entry through the normal recordReport
// path. Called once on boot (from the plugin's `onReady`) and after a
// rejection the serving backend survived.
export async function flushBufferedReports(): Promise<void> {
  const reports = readAndClearBuffer();
  for (const c of reports) {
    try {
      // A line that named its own kind carries its own payload; one that did
      // not is a process-level crash, and its payload is rebuilt from the flat
      // error fields the crash ReportKind validates. The default is what keeps
      // every pre-existing caller (and every line written by an older backend)
      // behaving exactly as before.
      await recordReport({
        kind: c.kind ?? "crash",
        source: c.source,
        message: c.message,
        data: c.data ?? {
          errorType: c.errorType ?? null,
          stack: c.stack ?? null,
        },
      });
      // eslint-disable-next-line promise-safety/no-bare-catch
    } catch (err) {
      console.error("[reports] failed to flush buffered report", err);
    }
  }
}
