import { serverPinCommit } from "@plugins/build/plugins/server-build-id/server";
import { reportsBufferDir } from "@plugins/reports/data-dirs";
import { crashFieldsOf } from "@plugins/packages/plugins/error-subject/core";
import { appendFileSync } from "node:fs";
import { bufferFile, type BufferedReport } from "./buffer";

// The DYING path's writes: synchronous BY NECESSITY — the process exits on the
// caller's next statement, so an async write would never finish. Only two
// callers, both on that path, and nothing else may import this file:
//
// - `appendUncaughtExceptionSync` — process-hooks.ts's `crash-buffer-sync`
//   lane: an uncaught exception on the serving backend (the listener exits 1
//   right after it returns). A rejection that backend survives takes the
//   async `record-async` lane instead (`crashWriteLane` decides, in one place);
// - `appendFatalReportSync` — fatal.ts's `serverFatalSink` handler, which only
//   server-core's `exitWithFatalReport` emits (it takes the exit and returns
//   `never`, so a process that lives on cannot reach it).
//
// A sync append on a backend that LIVES ON freezes its JS thread for as long
// as the disk answers (3-13 s stalls were measured on main) — so a new caller
// that is not exiting files through `recordReport` / `reportServer`, never
// here. The reads and the flush (buffer.ts) are async.

// The one write. Both public writers below go through it so the file format is
// described in exactly one place — and so the best-effort catch (we are on a
// dying event loop; throwing here would replace the report with a worse
// failure) is stated once rather than copied.
function appendLine(line: Omit<BufferedReport, "at" | "commit">): BufferAppend {
  try {
    reportsBufferDir.ensureSync();
    const stamped: BufferedReport = {
      ...line,
      at: new Date().toISOString(),
      commit: serverPinCommit(),
    };
    appendFileSync(bufferFile(), JSON.stringify(stamped) + "\n");
    return { ok: true };
  } catch (error) {
    // Best-effort: we're in a crash path; swallowing is better than throwing.
    return { ok: false, error };
  }
}

/** Whether a buffered line landed. */
export type BufferAppend = { ok: true } | { ok: false; error: unknown };

/** Buffer an uncaught exception synchronously — the process exits next. */
export function appendUncaughtExceptionSync(err: Error): BufferAppend {
  // The crash payload is derived here, while the error is still an object:
  // the line is all the next boot gets, and the error's own subject (a shared
  // throw site's, its cause's class code) is part of the report's identity.
  const data = crashFieldsOf(err);
  return appendLine({
    source: "server-uncaught",
    kind: "crash",
    data,
    errorType: data.errorType,
    message: err.message,
    stack: undefined,
  });
}

/**
 * Buffer a TYPED report synchronously — the durable half of server-core's
 * `exitWithFatalReport` (through fatal.ts).
 *
 * Returns once the bytes are handed to `appendFileSync` (or the write failed —
 * the result says which), so a caller may exit on the next statement. `data`
 * is NOT validated here: this side owns the buffer, and the kind owns its
 * payload. A payload the kind's schema rejects fails loudly on the next boot's
 * flush, where a stack trace can still be read.
 */
export function appendFatalReportSync(line: {
  kind: string;
  message: string;
  data: Record<string, unknown>;
}): BufferAppend {
  return appendLine({
    source: "server-fatal",
    kind: line.kind,
    data: line.data,
    // Flat crash fields carry the same message so a corrupt/unregistered-kind
    // line is still readable by a human tailing the file.
    errorType: line.kind,
    message: line.message,
    stack: undefined,
  });
}
