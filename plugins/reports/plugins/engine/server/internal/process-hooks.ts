import { appendReportSync, readAndClearBuffer } from "./buffer";
import { recordReport } from "./record-report";

let installed = false;

export function installProcessHooks(): void {
  if (installed) return;
  installed = true;

  process.on("uncaughtException", (err) => {
    appendReportSync("server-uncaught", err);
    // Match Node's default behavior for uncaughtException: exit non-zero.
    // The gateway restarts us and the next boot drains the buffer.
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    appendReportSync("server-unhandled", err);
    // Don't exit: rejections are recoverable in practice. The buffer is
    // flushed best-effort by flushBufferedReports below (next tick).
    // eslint-disable-next-line promise-safety/no-bare-catch, detached-work-safety/no-untracked-detached-work -- observability flush: drains buffered reports on unhandledRejection; must stay profiler-invisible
    void flushBufferedReports().catch((err) => {
      console.error(
        "[reports] flushBufferedReports failed in unhandledRejection handler",
        err,
      );
    });
  });
}

// Read the JSONL buffer and run each entry through the normal recordReport
// path. Called once on boot (from the plugin's `onReady`) and opportunistically
// after recoverable crashes.
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
