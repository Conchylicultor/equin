import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@plugins/database/server";
import type { UnfinishedRun } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import {
  HARD_KILL_EXIT_CODE,
  isRunAlive,
  type RunTerminal,
} from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { _backupRuns } from "./tables";
import { backupGapSummary } from "./report-kind";

/** The index the claiming INSERT contends on — see `./tables.ts`. */
const INFLIGHT_UQ = "backup_runs_inflight_uniq";

/**
 * node-postgres surfaces a unique violation as SQLSTATE 23505 plus the offending
 * constraint. The constraint is checked, not just the code: `backup_runs` also
 * has a primary key, and an id collision reported as "a backup is already
 * running" would be a plausible-looking lie about a different fault.
 */
function isInflightViolation(err: unknown): boolean {
  const pg = err as { code?: string; constraint?: string } | null;
  return pg?.code === "23505" && pg.constraint === INFLIGHT_UQ;
}

/**
 * Claim this namespace's single in-flight backup slot by INSERTing its ledger
 * row, and answer the run id — or `null` when a backup is already running.
 *
 * **The INSERT is the lock.** A check-then-act read before it would have a
 * TOCTOU window across two backend processes, where nothing in memory protects
 * anything; the partial unique index is the only arbiter.
 *
 * Seeded with this backend's own pid so the fresh row is not read as an orphan
 * in the window between the claim and the child's pid being known.
 */
export async function claimBackupRun(
  trigger: "manual" | "periodic",
): Promise<string | null> {
  const runId = crypto.randomUUID();
  try {
    await db.insert(_backupRuns).values({
      id: runId,
      trigger,
      namespace: runtimeNamespace(),
      pid: process.pid,
    });
    return runId;
  } catch (err) {
    if (isInflightViolation(err)) return null;
    throw err;
  }
}

/**
 * Every backup this namespace claimed that has not been stamped with an
 * outcome.
 *
 * **Scoped to `namespace`, which is not optional.** A worktree DB is a fork of
 * main's and inherits its rows, so an unscoped read would hand this worktree's
 * reconciler main's live backup: it would adopt a run whose transcript does not
 * exist here and close it with an outcome nobody in this namespace observed.
 */
export async function listUnfinishedBackups(): Promise<
  readonly UnfinishedRun[]
> {
  const rows = await db
    .select({ id: _backupRuns.id, pid: _backupRuns.pid })
    .from(_backupRuns)
    .where(
      and(
        isNull(_backupRuns.finishedAt),
        eq(_backupRuns.namespace, runtimeNamespace()),
      ),
    );
  return rows.map((row) => ({ runId: row.id, pid: row.pid }));
}

/**
 * Is a backup of this namespace genuinely running right now — an open row whose
 * process group is alive?
 *
 * The question `reconcileBackups` has to answer before it deletes anything, and
 * the honest form of it. An open ROW is not a running backup: after a hard kill
 * the row stays open until the supervised-run reconciler closes it, and if the
 * filesystem sweep waited for that it would skip exactly the wreckage it exists
 * to clear. A live process group is a running backup, and its staging directory
 * is mid-write — including one whose supervising shim alone was killed, which is
 * why the probe is `isRunAlive` (the group) and not the row's pid by itself.
 */
export async function hasLiveBackup(): Promise<boolean> {
  const rows = await listUnfinishedBackups();
  return rows.some((row) => isRunAlive(row.pid));
}

/** Record the pid of the detached child now serving this run. */
export async function setBackupPid(runId: string, pid: number): Promise<void> {
  await db.update(_backupRuns).set({ pid }).where(eq(_backupRuns.id, runId));
}

/**
 * Stamp this run's terminal outcome if the row is still open — the whole of the
 * supervised job's `closeRow`, and nothing else.
 *
 * A bare, idempotent, first-writer-wins write. It runs in the supervised-run
 * reconciler of **every** backend that sees the exit marker land, including one
 * that knows nothing about the workflow that started the backup, which is what
 * keeps a backup whose workflow died from holding `backup_runs_inflight_uniq`
 * against every future run.
 *
 * `status: "failed"` unconditionally, and that is not a guess about the exit
 * code. The child writes its own row — status, manifest, sizes, per-target
 * results — **and `finished_at` with it**, as its last act. So reaching here
 * with the row still open means the child ended without recording anything: it
 * was killed, or it crashed. Whatever its exit code says, this backup did not
 * complete.
 */
export async function closeBackupRow(
  runId: string,
  terminal: RunTerminal,
): Promise<void> {
  const detail =
    terminal.signalCode !== null
      ? `Backup process was killed by ${terminal.signalCode} before recording an outcome.`
      : terminal.exitCode === HARD_KILL_EXIT_CODE
        ? "Backup process disappeared without recording an outcome (hard kill)."
        : `Backup process exited ${terminal.exitCode} before recording an outcome.`;

  const closed = await db
    .update(_backupRuns)
    .set({
      status: "failed",
      finishedAt: terminal.finishedAt,
      targetResults: [{ targetId: "supervisor", ok: false, detail }],
    })
    .where(and(eq(_backupRuns.id, runId), isNull(_backupRuns.finishedAt)))
    .returning({ id: _backupRuns.id, trigger: _backupRuns.trigger });

  // The one failure the child cannot report on its own, because there is no
  // child left to do it: it died before writing anything. That is not a rare
  // shape — 2026-09-19 03:11 was a backup whose process could not open a
  // database connection at all — and until now it alerted nowhere, so the
  // report is filed here, from the backend that closed the row.
  //
  // Gated on `returning`, not fired unconditionally: this runs in the
  // reconciler of EVERY backend that sees the exit marker land, and only the
  // one whose UPDATE actually closed the row is entitled to say the run ended.
  // The others match no row and must stay silent.
  //
  // `recordReport` directly rather than the outbox: unlike the child, this IS a
  // backend, with the engine's velocity window and dedup memory already in it.
  const row = closed[0];
  if (row === undefined) return;
  const gaps = [{ kind: "run" as const, what: "Supervisor", error: detail }];
  await recordReport({
    kind: "backup-incomplete",
    source: "server-caught",
    message: backupGapSummary({ status: "failed", gaps }),
    // The trigger comes off the row this UPDATE just closed, not from a
    // default: a manually-triggered backup that died is a different thing to
    // read than a nightly one that did, and the report should not guess.
    data: { runId, status: "failed", trigger: row.trigger, gaps },
    occurredAt: terminal.finishedAt.getTime(),
  });
}
