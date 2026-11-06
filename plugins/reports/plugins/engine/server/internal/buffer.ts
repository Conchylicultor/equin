import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { unlink } from "node:fs/promises";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
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

export function bufferFile(): AppPath {
  return reportsBufferDir.file(`${runtimeNamespace()}.jsonl`);
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

export async function readAndClearBuffer(): Promise<BufferedReport[]> {
  const file = bufferFile();
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
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
    await unlink(file);
    // eslint-disable-next-line promise-safety/no-bare-catch
  } catch {
    // If unlink fails we'll re-process these on the next boot. Duplicate
    // entries collapse via the fingerprint unique index.
  }
  return reports;
}
