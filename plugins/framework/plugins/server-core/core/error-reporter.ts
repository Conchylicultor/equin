// Server-level error reporter hook.
// Infrastructure code (resources, jobs) calls reportServerError() to surface
// caught errors that would otherwise only hit console.error; the reports plugin
// handles `serverErrorSink` (a `sinkHandlers` entry). A held report sink: an
// error reported before the handler attaches — during boot, in any boot mode —
// is replayed to it, not dropped.
import {
  defineReportSink,
  defineRequestSink,
} from "@plugins/primitives/plugins/report-sink/core";

export interface ServerErrorReport {
  message: string;
  stack?: string | null;
  errorType?: string | null;
  /**
   * What the error is ABOUT when the throw site is shared code acting for many
   * subjects — a job's name, for a failure the jobs worker reports. Part of the
   * report's identity: without it every job that fails through the same
   * framework throw (supervised-job's dead-letter) lands on ONE row, titled
   * with whichever job failed last.
   */
  scope?: string | null;
}

export const serverErrorSink = defineReportSink<ServerErrorReport>();

export function reportServerError(report: ServerErrorReport): void {
  serverErrorSink.emit(report);
}

/**
 * A report a backend files about a named condition of its own — not a caught
 * error but a state it decided is wrong (a runner forfeited, a floor tripped).
 *
 * Separate from {@link ServerErrorReport} because it carries a `kind`: the
 * thing being reported is not a crash, and the kind is what lets it be
 * recorded as itself rather than as an anonymous stack.
 *
 * Filed one of two ways, and which one is decided by whether the process lives
 * on — never by the caller's taste:
 *
 * - {@link reportServer} — the process keeps running. Async, through the same
 *   durable path every report takes (a Postgres write, or the outbox from a
 *   process that does not serve).
 * - {@link exitWithFatalReport} — the process exits on the spot. Synchronous,
 *   because a dying event loop cannot finish an async write; the only way to
 *   reach the synchronous path, and it does the exit itself.
 */
export interface ServerReport {
  /** The report kind this resolves to when it is recorded. The kind must be
   * registered by SOME plugin in the recording composition, or recording it
   * logs a wiring error instead of filing anything. */
  kind: string;
  message: string;
  /** The kind's payload. Validated when recorded, by the kind's own schema —
   * never here, because this side must not import the interpretation layer. */
  data?: Record<string, unknown>;
}

/**
 * A typed report from a process that LIVES ON. A held report sink, like
 * {@link serverErrorSink}: one emitted before the handler attaches is replayed
 * to it. The reports engine handles it (a `sinkHandlers` entry) with
 * `recordReport` — async, so the backend's JS thread never waits on a disk.
 */
export const serverReportSink = defineReportSink<ServerReport>();

/** File a typed report from a process that keeps running (async, held). */
export function reportServer(report: ServerReport): void {
  serverReportSink.emit(report);
}

/**
 * The synchronous twin of {@link serverReportSink}: a REQUEST sink, never held —
 * a report held for a handler that attaches later is lost when the process
 * exits. The reports engine handles it through `sinkHandlers`, so it is
 * attached in every boot mode (an exec child — a supervised job's body —
 * included) from the `onReadyBlocking` phase on. The handler writes to disk
 * SYNCHRONOUSLY (the serving backend's crash buffer, flushed by its next boot;
 * the report outbox, drained by main, from a process that does not serve) and
 * answers whether the durable write landed.
 *
 * Emitted only by {@link exitWithFatalReport}: a synchronous disk write on a
 * backend that lives on freezes its JS thread for as long as the disk answers.
 */
export const serverFatalSink = defineRequestSink<ServerReport, boolean>();

/**
 * File a report synchronously, then exit the process with code 1 — the last
 * thing a process says before it deliberately leaves.
 *
 * It takes the exit and returns `never`, so a synchronous report from a
 * process that goes on running has no spelling: a caller that stays up files
 * through {@link reportServer}. `exit` is the caller's `process.exit` (this
 * module is portable and has no `process`).
 *
 * The handler has completed its durable write before `exit` runs. When nothing
 * filed it (no handler attached: the reports engine is not in this
 * composition, or boot has not reached its `onReadyBlocking`; or the write
 * failed) it says so on stderr, naming the report: a process on its way out
 * can do nothing else with that.
 */
export function exitWithFatalReport(
  report: ServerReport,
  exit: (code: number) => never,
): never {
  const filed = serverFatalSink.emit(report);
  if (filed !== true) {
    console.error(
      `[server-fatal] the "${report.kind}" report was NOT filed (${
        filed === undefined
          ? "no handler attached to serverFatalSink"
          : "its durable write failed"
      }): ${report.message}`,
    );
  }
  return exit(1);
}
