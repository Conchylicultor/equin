// Server-level error reporter hook.
// Infrastructure code (resources, jobs) calls reportServerError() to surface
// caught errors that would otherwise only hit console.error; the reports plugin
// handles `serverErrorSink` (a `sinkHandlers` entry). A held report sink: an
// error reported before the handler attaches — during boot, in any boot mode —
// is replayed to it, not dropped.
import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";

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
 * returns** — the implementation writes to disk and the next boot flushes it.
 *
 * It carries a `kind` because, unlike a caught error, the thing being reported
 * is not a crash: it is a named condition the caller decided to exit on, and the
 * kind is what lets the next boot render it as itself rather than as an
 * anonymous stack.
 */
export interface ServerFatalReport {
  /** The report kind the buffered line resolves to on the next boot. The kind
   * must be registered by SOME plugin in the composition, or the flush logs a
   * wiring error instead of filing anything. */
  kind: string;
  message: string;
  /** The kind's payload. Validated on the next boot by the kind's own schema —
   * never here, because this side must not import the interpretation layer. */
  data?: Record<string, unknown>;
}

type FatalReporter = (report: ServerFatalReport) => void;

let fatalReporter: FatalReporter | undefined;

export function setFatalReporter(fn: FatalReporter): void {
  fatalReporter = fn;
}

/**
 * File a report synchronously, immediately before a deliberate `process.exit()`.
 *
 * MUST have completed its durable write by the time it returns — the caller's
 * next statement is the exit. A no-op when nobody installed a reporter (the
 * `reports` plugin is not in this composition, or has not reached its
 * `onReady`), exactly like `reportServerError`: a caller on the way out cannot
 * do anything useful with that fact, and its own `console.error` is the floor.
 */
export function reportServerFatalSync(report: ServerFatalReport): void {
  fatalReporter?.(report);
}
