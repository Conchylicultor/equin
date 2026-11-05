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
 * A report filed on the way OUT of the process — the last thing a backend says
 * before it deliberately exits.
 *
 * Separate from {@link ServerErrorReport} because the two differ in the one way
 * that matters here: `reportServerError` hands its report to an ASYNC durable
 * path (a Postgres write), and the event loop a dying process has left cannot
 * run one. So this pair's contract is **synchronous, and durable before it
 * returns** — the implementation writes to disk (the serving backend's crash
 * buffer, flushed by its next boot; the report outbox, drained by main, from a
 * process that does not serve).
 *
 * It carries a `kind` because, unlike a caught error, the thing being reported
 * is not a crash: it is a named condition the caller decided to exit on, and the
 * kind is what lets the next boot render it as itself rather than as an
 * anonymous stack.
 */
export interface ServerFatalReport {
  /** The report kind the durable line resolves to when it is recorded. The
   * kind must be registered by SOME plugin in the recording composition, or the
   * flush logs a wiring error instead of filing anything. */
  kind: string;
  message: string;
  /** The kind's payload. Validated when recorded, by the kind's own schema —
   * never here, because this side must not import the interpretation layer. */
  data?: Record<string, unknown>;
}

/**
 * The synchronous twin of {@link serverErrorSink}: a REQUEST sink, never held —
 * a report held for a handler that attaches later is lost when the caller's
 * next statement exits the process. The reports engine handles it through
 * `sinkHandlers`, so it is attached in every boot mode (an exec child — a
 * supervised job's body — included) from the `onReadyBlocking` phase on. The
 * handler answers whether the durable write landed.
 */
export const serverFatalSink = defineRequestSink<ServerFatalReport, boolean>();

/**
 * File a report synchronously, immediately before a deliberate `process.exit()`.
 *
 * The handler has completed its durable write by the time this returns — the
 * caller's next statement is the exit. When nothing filed it (no handler
 * attached: the reports engine is not in this composition, or boot has not
 * reached its `onReadyBlocking`; or the write failed) it says so on stderr,
 * naming the report: a caller on the way out can do nothing else with that.
 */
export function reportServerFatalSync(report: ServerFatalReport): void {
  const filed = serverFatalSink.emit(report);
  if (filed === true) return;
  console.error(
    `[server-fatal] the "${report.kind}" report was NOT filed (${
      filed === undefined
        ? "no handler attached to serverFatalSink"
        : "its durable write failed"
    }): ${report.message}`,
  );
}
