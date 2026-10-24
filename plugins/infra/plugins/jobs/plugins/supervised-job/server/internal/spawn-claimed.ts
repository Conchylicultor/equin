import { HARD_KILL_EXIT_CODE, type RunTerminal } from "../../core";
import { isSupervisedSpawnError } from "./run/supervisor";

/** The two halves of starting a run whose ledger row already exists. */
export interface SpawnClaimedArms {
  /** Spawn the child for this run. */
  start(): Promise<{ pid: number }>;
  /** The kind's bare terminal write — see `SupervisedJobKindSpec.closeRow`. */
  closeRow(runId: string, terminal: RunTerminal): Promise<void>;
}

/**
 * Spawn the child for an already-claimed run, and close the row **only if no
 * child was ever started**.
 *
 * Between `claim` and a live child there is a window where the ledger row exists
 * and nothing will ever finish it. If the start fails before `Bun.spawn` — no
 * `./equin` on PATH, a duplicate run id, `EAGAIN` — the row is left
 * holding `process.pid`, which is THIS backend's own and very much alive. The
 * reconciler's close rule reads it as *running* on every pass, forever, because
 * no child exists to write a marker and no pid will die until the backend does.
 * **That row is the kind's lock** (the partial unique in-flight index), so the
 * kind then refuses every future run — build, release and deploy alike — with no
 * symptom at the call site. Closing it is the repair, and it lives here once
 * rather than in each consumer's catch (release carried exactly this code as
 * `failUnstartedRelease`).
 *
 * **After the spawn, the same close would be a bug, and a worse one.** A failure
 * in the bookkeeping that follows `Bun.spawn` — the `setPid` write, the watcher
 * — leaves a child that is genuinely running: it will write its transcript and
 * its exit marker, and the reconciler settles it through the ordinary path.
 * Stamping `finished_at` there RELEASES the in-flight lock while that child runs,
 * so the next enqueue claims cleanly and spawns a second one — two concurrent
 * builds against one checkout, two converges against one remote server. Doing
 * nothing on that side is not a gap; it is the correct action.
 *
 * Which side it failed on is therefore never inferred here. `startSupervisedRun`
 * reports it as `SupervisedSpawnError.childStarted`, derived from whether the pid
 * was actually assigned, and the guard below **compensates only on positive proof
 * that no child exists** — an unrecognised error is treated as "a child may be
 * running", because a wedged kind is recoverable by a restart and a duplicated
 * build is not.
 *
 * The sentinel is `HARD_KILL_EXIT_CODE`, the same value the reconciler would
 * stamp on this row after a restart, and honest for the same reason: no marker
 * was ever written, and none ever will be.
 *
 * The original error is always what propagates — the job must still fail loudly
 * and earn its report. If the close ALSO fails, both errors travel together in
 * an `AggregateError`, because at that point the kind really is wedged until a
 * restart and the message is the only warning anyone gets.
 */
export async function spawnClaimedRun(
  arms: SpawnClaimedArms,
  runId: string,
): Promise<{ pid: number }> {
  try {
    return await arms.start();
  } catch (spawnError) {
    if (childMayBeRunning(spawnError)) throw spawnError;
    await closeAfterFailedSpawn(arms, runId, spawnError);
    throw spawnError;
  }
}

/**
 * Whether a child might exist behind this failure — the question the
 * compensating close is gated on.
 *
 * True unless `startSupervisedRun` positively says otherwise. The default
 * direction is deliberate: releasing the lock under a live child duplicates the
 * run, which nothing recovers from, while leaving it held wedges the kind until
 * the backend restarts, which is loud and recoverable.
 */
export function childMayBeRunning(err: unknown): boolean {
  return !isSupervisedSpawnError(err) || err.childStarted;
}

async function closeAfterFailedSpawn(
  arms: SpawnClaimedArms,
  runId: string,
  spawnError: unknown,
): Promise<void> {
  try {
    await arms.closeRow(runId, {
      exitCode: HARD_KILL_EXIT_CODE,
      signalCode: null,
      finishedAt: new Date(),
    });
  } catch (closeError) {
    throw new AggregateError(
      [spawnError, closeError],
      `[supervised-job] run ${runId}: the spawn failed AND its ledger row could not be closed — ` +
        `the kind's in-flight lock is held until this backend restarts.`,
    );
  }
}
