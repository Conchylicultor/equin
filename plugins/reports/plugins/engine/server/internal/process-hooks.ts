import {
  isServerReady,
  processCrashSink,
  sinkHandler,
} from "@plugins/framework/plugins/server-core/core";
import type { ProcessCrash } from "@plugins/framework/plugins/server-core/core";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import type { ReportInput } from "@plugins/reports/core";
import { readAndClearBuffer, type BufferedReport } from "./buffer";
import { appendUncaughtExceptionSync } from "./crash-append";
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
 * Where a crash is written is decided in ONE place, `crashWriteLane`, by two
 * facts: whether the process is dying (an uncaught exception: the listener
 * exits 1 next; a rejection is survived) and whether it is SERVING (the ready
 * backend that writes `reports`). A synchronous write is safe on a dying
 * process (an async one would never land) and on one that does not serve yet
 * or at all (no request waits on its thread); it freezes only a backend that
 * is serving and goes on serving — so that one combination is the only async
 * lane, and the only lane `recordReport` is reached from.
 *
 * - **dying, serving**: one line in this namespace's crash buffer, replayed by
 *   `flushBufferedReports` on its next boot;
 * - **not serving** — an exec child, a CLI, or a serving backend still booting
 *   (its next boot may crash at the same point, before it flushes) — dying or
 *   not: one entry in the report outbox, written synchronously, drained by
 *   main. Durable before the handler returns, so a boot that rejects and then
 *   exits, or an exec child's rejection after its shutdown drained the async
 *   writes, still files it;
 * - **survived, serving**: `recordReport`, async. The answer is "handed off";
 *   a write that then fails is printed.
 */
export const processCrashHandler = sinkHandler(
  processCrashSink,
  () => fileProcessCrash,
);

/** How one crash is written — see {@link processCrashHandler}. */
export type CrashWriteLane =
  "crash-buffer-sync" | "outbox-sync" | "record-async";

/** The one decision of where a crash is written (exported for its test). */
export function crashWriteLane(
  event: ProcessCrash["event"],
  serving: boolean,
): CrashWriteLane {
  if (!serving) return "outbox-sync";
  return event === "uncaughtException" ? "crash-buffer-sync" : "record-async";
}

function fileProcessCrash({ event, error }: ProcessCrash): boolean {
  const lane = crashWriteLane(
    event,
    reportsProducer.writesHere() && isServerReady(),
  );
  switch (lane) {
    case "crash-buffer-sync":
      return appendToCrashBufferSync(error);
    case "outbox-sync":
      return fileToOutboxSync(event, error);
    case "record-async":
      return recordSurvivedRejection(error);
  }
}

function appendToCrashBufferSync(error: Error): boolean {
  const appended = appendUncaughtExceptionSync(error);
  if (!appended.ok) {
    console.error(
      "[reports] could not append the uncaughtException to the crash buffer:",
      appended.error,
    );
  }
  return appended.ok;
}

function fileToOutboxSync(event: ProcessCrash["event"], error: Error): boolean {
  const filed = reportOutboxFatalSink.emit(
    outsideServingInput(
      event === "uncaughtException"
        ? "Uncaught exception"
        : "Unhandled rejection",
      error,
    ),
  );
  if (filed === undefined) {
    console.error(
      `[reports] no outbox writer attached to reportOutboxFatalSink (reports/outbox is not in this composition, or has not reached its onReadyBlocking) — the ${event} cannot be filed from this process`,
    );
  }
  return filed === true;
}

function recordSurvivedRejection(error: Error): boolean {
  const input: ReportInput = {
    kind: "crash",
    source: "server-unhandled",
    message: error.message,
    data: { errorType: error.name, stack: error.stack ?? null },
  };
  // Caught, never rethrown: a rejection from here would come straight back to
  // this handler — a failing database would loop. Printed instead.
  // eslint-disable-next-line promise-safety/no-bare-catch, detached-work-safety/no-untracked-detached-work -- observability write for a rejection the process survives; a rethrow would re-enter this handler
  void recordReport(input).catch((err: unknown) => {
    console.error(
      "[reports] could not record an unhandled rejection the process survived:",
      err,
      "— the rejection:",
      error,
    );
  });
  return true;
}

/** A crash filed from a process that does not (yet) serve — named for where. */
function outsideServingInput(
  what: string,
  error: Error,
): { kind: "crash"; message: string; data: Record<string, unknown> } {
  const where = reportsProducer.writesHere()
    ? "the booting backend"
    : "a background process (exec child or CLI)";
  return {
    kind: "crash",
    message: `${what} in ${where} of ${runtimeNamespace()}: ${error.message}`,
    data: { errorType: error.name, stack: error.stack ?? null },
  };
}

// Read the JSONL buffer and run each entry through the normal recordReport
// path. Called once on boot (from the plugin's `onReady`).
export async function flushBufferedReports(): Promise<void> {
  const reports = await readAndClearBuffer();
  for (const c of reports) {
    try {
      await recordReport(replayedReportInput(c));
      // eslint-disable-next-line promise-safety/no-bare-catch
    } catch (err) {
      console.error("[reports] failed to flush buffered report", err);
    }
  }
}

/**
 * One buffered line as the occurrence it records — the WRITER's: its instant
 * (`at`) and its commit, never the flushing boot's, which may run other code
 * (main's HEAD moves while a crashed backend is down). On 2026-11-08 a crash
 * buffered by the unfixed 9b06a6dcc5 replayed 11 min later stamped with the
 * new HEAD, which contained the fix, and read as a regression. A line from an
 * older backend names no commit: unknown (null) — passing `undefined` would
 * let `stampCommit` fill in this process's pin.
 *
 * A line that named its own kind carries its own payload; one that did not is
 * a process-level crash, whose payload is rebuilt from the flat error fields
 * the crash ReportKind validates (every line written by an older backend
 * reads that way too).
 */
export function replayedReportInput(c: BufferedReport): ReportInput {
  // An unreadable instant (only a hand-edited or torn line — appendLine always
  // writes one) is said, and the crash is still recorded, at the flush time:
  // the buffer is already unlinked, so refusing the line would lose it.
  const occurredAt = Date.parse(c.at);
  if (Number.isNaN(occurredAt)) {
    console.error(
      `[reports] buffered report has no valid \`at\` (${String(c.at)}); recorded at the flush time`,
    );
  }
  return {
    kind: c.kind ?? "crash",
    source: c.source,
    message: c.message,
    commit: c.commit ?? null,
    ...(Number.isNaN(occurredAt) ? {} : { occurredAt }),
    data: c.data ?? {
      errorType: c.errorType ?? null,
      stack: c.stack ?? null,
    },
  };
}
