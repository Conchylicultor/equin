import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { fileReportFromProcess } from "@plugins/reports/plugins/outbox/core";
import type {
  BackupSourceFailed,
  BackupSourceReport,
} from "@plugins/backup/core";
import { assembleArchive } from "./assemble-archive";
import { BackupTarget } from "./contribution";
import { _backupRuns } from "./tables";
import { backupGapSummary, type BackupGap } from "./report-kind";

/**
 * The backup itself: the `run` body of `backupRunJob`, executed in its own
 * process (`./equin supervised-exec backup.run.supervised`).
 *
 * A backup is ~11 contributed sources staged into a directory, one `tar`, and
 * ~2 contributed targets — there is no command line to type, so before it ran
 * out of process it was an in-process job handler and a backend restart killed
 * it mid-`tar`. The child boots the plugin graph in `exec` mode, which is what
 * makes `BackupSource` / `BackupTarget` contributions and the config registry
 * present here exactly as they are in the backend. Nothing is passed in but the
 * run id and what triggered it.
 *
 * **This row is claimed before the child exists** (`claimBackupRun`, in the
 * job's ledger `claim`), so everything here is an UPDATE. The final update — the
 * one that writes `finished_at` — is the last act of the run, which is what
 * makes a still-open row at exit unambiguously mean "the process died without
 * recording anything" (see `closeBackupRow`).
 */
export async function runBackupBody(
  runId: string,
  trigger: "manual" | "periodic",
): Promise<void> {
  // The row must already exist: every UPDATE below is keyed on it, and an
  // UPDATE that matches nothing is silent. A child spawned with a run id that
  // names no row would archive gigabytes, upload them, and report success
  // into the void.
  const [row] = await db
    .select({ id: _backupRuns.id })
    .from(_backupRuns)
    .where(eq(_backupRuns.id, runId))
    .limit(1);
  if (row === undefined) {
    throw new Error(
      `[backup] no backup_runs row for ${runId} — this child was spawned with ` +
        `a run id its claim never wrote, so nothing it did could be recorded.`,
    );
  }

  let archive;
  try {
    archive = await assembleArchive(trigger);
  } catch (err) {
    await db
      .update(_backupRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        targetResults: [
          {
            targetId: "assembler",
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          },
        ],
      })
      .where(eq(_backupRuns.id, runId));
    // The assembly can still throw even with every source isolated — the tar
    // itself times out or fails, the same-second run-directory guard fires, or
    // `backupExclusions()` refuses in a process that collected no
    // contributions. Those produce NO archive, which is the worst outcome
    // there is, and before this call they were the one failure that reached no
    // funnel: the 2026-09-11 pair were tar timeouts and alerted nowhere.
    await reportIncomplete(runId, trigger, "failed", [
      {
        kind: "run",
        what: "Assembly",
        error: err instanceof Error ? err.message : String(err),
      },
    ]);
    // Rethrown so the process exits non-zero: that status is what the shim
    // records into the exit marker, and the marker is what the supervising
    // workflow reads. The row is already stamped, so the close is a no-op.
    throw err;
  }

  const targets = BackupTarget.getContributions();
  const results = await Promise.all(
    targets.map((t) =>
      t.run(archive).catch((err) => ({
        targetId: t.id,
        ok: false as const,
        detail: err instanceof Error ? err.message : String(err),
      })),
    ),
  );

  // Sources that threw. They are the other half of the verdict, and until now
  // they were no part of it: the status came from the target tally alone, so a
  // run whose databases source blew up and whose uploads then went fine was
  // recorded `ok`. An archive missing a source is not a success, and the whole
  // point of assembling sources independently is that this is now a REPORTABLE
  // degradation rather than a total loss — which only holds if the status says
  // so.
  const failedSources = archive.manifest.sources.filter(isFailedSource);
  const failedTargets = results.filter((r) => !r.ok);
  const anyTargetOk = results.some((r) => r.ok);

  const status = !anyTargetOk
    ? "failed"
    : failedTargets.length > 0 || failedSources.length > 0
      ? "partial"
      : "ok";

  await db
    .update(_backupRuns)
    .set({
      status,
      finishedAt: new Date(),
      archiveSizeBytes: archive.manifest.sizeBytes,
      manifest: archive.manifest,
      targetResults: results,
    })
    .where(eq(_backupRuns.id, runId));

  if (status !== "ok") {
    await reportIncomplete(runId, trigger, status, [
      ...failedSources.map((s): BackupGap => ({
        kind: "source",
        what: s.name,
        error: s.error,
      })),
      ...failedTargets.map((t): BackupGap => ({
        kind: "target",
        what: t.targetId,
        error: t.detail ?? "no detail",
      })),
    ]);
  }

  // A run that reached no target at all is a failed run, and the process has
  // to say so: the ledger row is the record, but the EXIT STATUS is what the
  // runs UI, the marker and the workflow all read as the outcome. Exiting 0
  // after every upload failed would report a backup that archived nothing as
  // a success.
  if (status === "failed") {
    throw new Error(
      `[backup] every target failed: ${results
        .map((r) => `${r.targetId}: ${r.detail ?? "no detail"}`)
        .join("; ")}`,
    );
  }
}

/** The `failed` arm of the source union, as a predicate `filter` can narrow by. */
function isFailedSource(s: BackupSourceReport): s is BackupSourceFailed {
  return s.outcome === "failed";
}

/**
 * Put the gap in the alert funnel.
 *
 * Every way this run can come up short goes through here, which is the point:
 * the `failed` arms all end in a `throw`, and a report written after one would
 * never exist on exactly the runs that most need it. Awaited for the same
 * reason — this process is about to end, and a floating write would die with
 * it.
 */
async function reportIncomplete(
  runId: string,
  trigger: "manual" | "periodic",
  status: "partial" | "failed",
  gaps: readonly BackupGap[],
): Promise<void> {
  // Through the OUTBOX, not `recordReport`. This process is a supervised child
  // — which is the case the outbox names — and although it does hold a database
  // connection, the reports engine is more than a row: its velocity window,
  // fan-out ceiling and duress shed buffer are per-process in-memory state, and
  // a process that exits seconds later would dedupe and storm-account against
  // nothing. Writing one file and letting main's drain record it puts this
  // report through the same engine, with the same memory, as every other.
  //
  // No `code`: the staleness rule asks whether the repo files a report is about
  // have moved since the writer's branch point, and this report is about the
  // machine's data, not about any source file. The drain skips the rule
  // entirely for an entry that carries none.
  const result = await fileReportFromProcess({
    kind: "backup-incomplete",
    message: backupGapSummary({ status, gaps }),
    data: { runId, status, trigger, gaps },
  });
  if (result.outcome !== "written") {
    // `fileReportFromProcess` has already printed why, loudly, and never
    // throws. Say the consequence here — this run's gap reached no funnel —
    // into the transcript the run itself keeps.
    console.error(
      `[backup] run ${runId} ended ${status} and its report could not be filed`,
    );
  }
}
