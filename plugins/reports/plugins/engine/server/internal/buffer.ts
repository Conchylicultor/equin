import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { appendFileSync, readFileSync, unlinkSync } from "node:fs";
import { reportsBufferDir } from "@plugins/reports/data-dirs";
import type { ReportSource } from "@plugins/reports/core";

// Server crashes during `uncaughtException` can't write to Postgres (the
// driver is async and the event loop is dying). We buffer to a JSONL file
// under the user's home so re-forks / branch switches don't wipe it, then
// flush on the next boot via `flushBufferedReports`. The directory itself is
// declared in this plugin's `data-dirs/index.ts`.
//
// The same constraint applies to a DELIBERATE exit — a backend that decides its
// own state is unrecoverable and calls `process.exit(1)` has exactly as little
// event loop left as one that crashed. So the buffered line carries an optional
// `kind` + `data`, which is what lets `reportServerFatalSync` file a TYPED
// report on the way out instead of an anonymous crash. Lines written without
// them (every `appendReportSync` caller, and every line left by an older
// backend) read back as the `crash` kind, so nothing about the existing path
// changed.

function bufferFile(): string {
  return reportsBufferDir.file(`${runtimeNamespace()}.jsonl`);
}

// The one write. Both public writers below go through it so the file format is
// described in exactly one place — and so the best-effort swallow (we are on a
// dying event loop; throwing here would replace the report with a worse
// failure) is stated once rather than copied.
function appendLine(line: Omit<BufferedReport, "at">): void {
  try {
    reportsBufferDir.ensure();
    appendFileSync(
      bufferFile(),
      JSON.stringify({ ...line, at: new Date().toISOString() }) + "\n",
    );
    // eslint-disable-next-line promise-safety/no-bare-catch
  } catch {
    // Best-effort: we're in a crash path; swallowing is better than throwing.
  }
}

export function appendReportSync(source: ReportSource, err: Error): void {
  appendLine({
    source,
    errorType: err.name,
    message: err.message,
    stack: err.stack,
  });
}

/**
 * Buffer a TYPED report synchronously — the durable half of
 * `reportServerFatalSync`.
 *
 * Returns once the bytes are handed to `appendFileSync`, so a caller may exit
 * on the next statement. `data` is NOT validated here: this side owns the
 * buffer, and the kind owns its payload. A payload the kind's schema rejects
 * fails loudly on the next boot's flush, where a stack trace can still be read.
 */
export function appendFatalReportSync(line: {
  source: ReportSource;
  kind: string;
  message: string;
  data: Record<string, unknown>;
}): void {
  appendLine({
    source: line.source,
    kind: line.kind,
    data: line.data,
    // Flat crash fields carry the same message so a corrupt/unregistered-kind
    // line is still readable by a human tailing the file.
    errorType: line.kind,
    message: line.message,
    stack: undefined,
  });
}

// A buffered report captured synchronously during a dying event loop — a
// process-level crash, or a deliberate exit that named its own condition.
//
// Flat crash fields (not a ReportInput) — flushBufferedReports wraps these into
// the crash ReportKind payload on the next boot, unless the line names its own
// kind.
export interface BufferedReport {
  source: ReportSource;
  /**
   * The report kind this line resolves to. ABSENT on every crash-path line
   * (and on every line written by a backend from before typed fatal reports),
   * which is why the flush defaults it to `crash` rather than requiring it —
   * an unreadable old line would otherwise lose a crash record.
   */
  kind?: string;
  /** The kind's payload, when the line names a kind. The crash kind's payload is
   * rebuilt from the flat fields below instead. */
  data?: Record<string, unknown>;
  errorType: string;
  message: string;
  stack: string | undefined;
  at: string;
}

export function readAndClearBuffer(): BufferedReport[] {
  const file = bufferFile();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return [];
  }
  const reports: BufferedReport[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      reports.push(JSON.parse(trimmed) as BufferedReport);
      // eslint-disable-next-line promise-safety/no-bare-catch
    } catch {
      // Skip corrupt lines rather than failing the whole flush.
    }
  }
  try {
    unlinkSync(file);
    // eslint-disable-next-line promise-safety/no-bare-catch
  } catch {
    // If unlink fails we'll re-process these on the next boot. Duplicate
    // entries collapse via the fingerprint unique index.
  }
  return reports;
}
