import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import {
  HARD_KILL_EXIT_CODE,
  isRunAlive,
  readRunTerminal,
} from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { BUILD_RUN_KIND_ID } from "../core";

// Settling a DEAD holder of `build_runs_inflight_uniq`, at the moment the lock
// is actually blocking someone.
//
// Only two paths in `./equin build` close its own row (the ok verdict and
// the failure-verdict funnel). An early `process.exit`, a throw unwinding to
// `runCli`, a catchable signal and a SIGKILL all leave it open — and the exit
// hook cannot close it, because it runs only synchronous code and the close is a
// database write. The backend's supervised-run reconciler would reap it, but only
// on backend boot, and a failed build never restarts the backend. So the open row
// used to block every later build of the namespace until some build got far
// enough to restart it.
//
// The fix is that WHOEVER LOSES THE CLAIM decides whether the holder is dead,
// with the same rule the supervised reconciler applies (`settleRun`):
//
//   terminal = build's own terminal record ?? (run alive ? STILL RUNNING : hard kill -1)
//
// "Run alive" is `isRunAlive`: the holder pid OR its process group. A build the
// backend started is a supervised run whose row pid is the shim — the leader of
// the group the real `./equin build` lives in — so a shim killed alone
// must not read as a dead holder. A plain CLI build's pid is covered by the
// pid half of the same probe.
//
// Race-safety: this runs only AFTER an insert lost to the index, and closes only
// a row whose build provably ended — a dead process does not come back. Two
// claimants settling the same row is harmless (the guarded UPDATE matches for
// one of them), and both retries go back through the index, which still picks
// exactly one winner. A recycled pid can only read as ALIVE, which is today's
// "lost" outcome, never a live build closed.
//
// Eval-safe for the CLI like the rest of this leaf: supervised-job/core touches
// no db and no jobs queue, and paths/core is node:os/node:path resolution only.

/** The in-flight row's two columns the settle reads. */
const HolderRowSchema = z.object({
  id: z.string(),
  pid: z.number().int().nullable(),
});

/** How a build ended, as its run's exit marker records it. */
export interface BuildTerminal {
  exitCode: number;
  /** The marker's mtime — when the build ended, not when we looked. */
  finishedAt: Date;
}

/**
 * Read a build's terminal record: its supervised run's exit marker
 * (`runs/build-<id>.exit-code`), which every build has — the backend's shim
 * writes it for a build the backend started, the attached relay for a hand-run
 * one — on every ending but a hard kill. Its exit code is the build process's
 * real status, and its mtime the real end time.
 *
 * `null` means no record: the build is still running, or it was SIGKILLed (no
 * handler ran). The caller tells them apart with the pid. A marker that exists
 * but does not parse THROWS (`RunMarkerError`): it is published by rename, so
 * malformed bytes are a writer defect, never a hard kill.
 */
export async function readBuildTerminal(
  namespace: Namespace,
  buildId: string,
): Promise<BuildTerminal | null> {
  const terminal = await readRunTerminal(BUILD_RUN_KIND_ID, buildId, namespace);
  return terminal === null
    ? null
    : { exitCode: terminal.exitCode, finishedAt: terminal.finishedAt };
}

/**
 * Close this namespace's in-flight `build_runs` row iff its build provably
 * ended. `true` ⇒ the slot is (now) free and the caller may retry its claim
 * once; `false` ⇒ a live build holds it.
 *
 * Called by both claimants on a `build_runs_inflight_uniq` violation: the CLI's
 * `insertRun` and the backend's `claimBuildRun`.
 *
 * The close is the same first-writer-wins UPDATE every other writer uses
 * (`where id = ? and finished_at is null`), stamping ONLY `finished_at` and
 * `exit_code` — an UPDATE names only its assigned columns, so it is immune to
 * the CLI-vs-deployed-schema skew `recorder.ts` documents.
 */
export async function settleDeadInflightRun(
  db: NodePgDatabase,
  namespace: Namespace,
): Promise<boolean> {
  // Hand SQL naming only its columns — see `recorder.ts` for why this module
  // never imports the table.
  const [holder] = await executeRows(db, {
    query: sql`
      select "id", "pid" from "build_runs"
      where "namespace" = ${namespace} and "finished_at" is null
    `,
    row: HolderRowSchema,
    label: "build_runs in-flight holder",
  });
  // The holder closed between our failed insert and this read — the slot is free.
  if (holder === undefined) return true;

  const recorded = await readBuildTerminal(namespace, holder.id);
  let terminal: BuildTerminal;
  if (recorded !== null) {
    terminal = recorded;
  } else if (isRunAlive(holder.pid)) {
    return false;
  } else {
    // No record and no process: a SIGKILL, which runs no handler.
    terminal = { exitCode: HARD_KILL_EXIT_CODE, finishedAt: new Date() };
  }

  // sql-writes:hand-written — the CLI's first-writer-wins close, against the previous build's schema
  await db.execute(sql`
    update "build_runs"
    set "finished_at" = ${terminal.finishedAt}, "exit_code" = ${terminal.exitCode}
    where "id" = ${holder.id} and "finished_at" is null
  `);
  return true;
}
