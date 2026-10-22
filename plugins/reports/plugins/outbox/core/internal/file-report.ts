import { mkdir, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import { getMainRepoRoot } from "@plugins/infra/plugins/spawn/core";
import { reportOutboxDir } from "../../data-dirs";
import {
  OutboxEntrySchema,
  isOutboxEntryName,
  newOutboxEntryName,
  outboxTempName,
  type OutboxEntry,
  type ProcessReport,
} from "./entry";

/**
 * The most entries the outbox holds. Main drains within a second of a write, so
 * a full outbox means main has been down (or its drain broken) for a long time
 * — and past that point a new entry adds nothing an old one does not already
 * say. Refusing keeps the directory bounded by construction.
 */
export const OUTBOX_MAX_PENDING = 1_000;

/**
 * Which repository `root` is a checkout of: the realpath of its main checkout,
 * so every worktree of one clone answers the same and a symlinked path (macOS
 * `/tmp`) cannot make one repository look like two. Stamped by the writer and
 * compared by the drain.
 */
export async function repositoryOf(root: string): Promise<string> {
  return realpath(await getMainRepoRoot(root));
}

/** What became of one `fileReportFromProcess` call. */
export type FileReportOutcome =
  | { outcome: "written"; path: string }
  /** The outbox already holds `OUTBOX_MAX_PENDING` entries. */
  | { outcome: "refused"; pending: number }
  | { outcome: "failed"; error: unknown };

/**
 * File a report from a process that has no server: write it into the
 * host-global outbox, where main's backend picks it up and records it
 * (`reports/outbox` server).
 *
 * **Never throws, never rejects.** Its callers are diagnostics running beside
 * real work — a check run's thread watch above all — and a diagnostic that can
 * fail the work it observes would change a verdict. Every failure prints one
 * loud `console.error` line instead, and comes back as a result arm.
 *
 * The entry is written under a temp name and renamed into place, so the drain
 * never reads half a file.
 *
 * `dir` is for tests; production callers take the declared outbox.
 */
export async function fileReportFromProcess(
  report: ProcessReport,
  opts: { dir?: string; now?: number } = {},
): Promise<FileReportOutcome> {
  const dir = opts.dir ?? reportOutboxDir.path;
  try {
    await mkdir(dir, { recursive: true });
    const pending = (await readdir(dir)).filter(isOutboxEntryName).length;
    if (pending >= OUTBOX_MAX_PENDING) {
      console.error(
        `[report-outbox] refused a "${report.kind}" report: ${dir} already holds ` +
          `${pending} undrained entries (cap ${OUTBOX_MAX_PENDING}). Main's backend ` +
          "drains this directory — is it running?",
      );
      return { outcome: "refused", pending };
    }
    const now = opts.now ?? Date.now();
    // Parsed on the way OUT too: a malformed entry (a bad merge-base, an
    // absolute path) fails here, in the writer's own terminal, rather than as
    // a crash report on main that names nobody.
    const entry: OutboxEntry = OutboxEntrySchema.parse({
      version: 1,
      kind: report.kind,
      message: report.message,
      data: report.data,
      code: report.code,
      occurredAt: now,
      writer: {
        pid: process.pid,
        checkout: basename(REPO_ROOT),
        repo: await repositoryOf(REPO_ROOT),
      },
    });
    const name = newOutboxEntryName(now, process.pid);
    const temp = join(dir, outboxTempName(name));
    const path = join(dir, name);
    await writeFile(temp, JSON.stringify(entry));
    await rename(temp, path);
    return { outcome: "written", path };
  } catch (error) {
    console.error(
      `[report-outbox] could not file a "${report.kind}" report into ${dir}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { outcome: "failed", error };
  }
}
