import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@plugins/database/server";
import type { UnfinishedRun } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import type { RunTerminal } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";
import { recordNotification } from "@plugins/shell/plugins/notifications/server";
import { buildDetailRoute, isMainCompositionBuild } from "@plugins/build/core";
import {
  buildStatusOf,
  killedSignalName,
} from "@plugins/build/plugins/build-status/core";
import {
  _buildRuns,
  settleDeadInflightRun,
} from "@plugins/build/plugins/run-ledger/server";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { deploymentServed } from "@plugins/build/plugins/deployment/server";
import { reconcileDeployment } from "./reconcile";
import { announceRunTerminal } from "./run-terminal";
import {
  buildRunIdKind,
  type BuildRunId,
} from "@plugins/build/plugins/run-ledger/core";

/** The index the claiming INSERT contends on — see `run-ledger`'s `tables.ts`. */
const INFLIGHT_UQ = "build_runs_inflight_uniq";

/**
 * node-postgres surfaces a unique violation as SQLSTATE 23505 plus the offending
 * constraint. The constraint is checked, not just the code: `build_runs` also has
 * a primary key, and an id collision reported as "a build is already running"
 * would be a plausible-looking lie about a different fault.
 */
function isInflightViolation(err: unknown): boolean {
  const pg = err as { code?: string; constraint?: string } | null;
  return pg?.code === "23505" && pg.constraint === INFLIGHT_UQ;
}

/**
 * Claim this namespace's single in-flight build slot by INSERTing its ledger row.
 *
 * **The INSERT is the lock.** The partial unique index on `(namespace) WHERE
 * finished_at IS NULL` is what wins or loses the race between two triggers in
 * different backend processes, where an in-process flag protects nothing. Seeded
 * with this backend's own live pid so the fresh row is not read as an orphan in
 * the window before the child's pid is known.
 *
 * `false` means a LIVE build holds the slot. That is an ordinary outcome, not a
 * fault: auto-build is a convergence loop, so a dropped request is re-derived at
 * the next edge rather than queued. `defineSupervisedJob` turns that into a
 * `null` claim, and the handler returns without spawning anything.
 *
 * A holder whose build already ended (an early exit, a throw, a signal or a
 * SIGKILL that left its row open) does not drop the request: on the index
 * violation the holder is settled from the build's own terminal record
 * (`settleDeadInflightRun`, shared with the CLI's `insertRun`) and the INSERT is
 * retried once. The index still decides that retry.
 */
export async function claimBuildRun(row: {
  /** A FRESH id — `buildRunIdKind.mint()`, never a key read back from elsewhere. */
  buildId: BuildRunId;
  trigger: "manual" | "auto";
  commitHash: string | null;
  targets: string[];
}): Promise<boolean> {
  const namespace = runtimeNamespace();
  const insert = async (): Promise<void> => {
    await db.insert(_buildRuns).values({
      id: row.buildId,
      trigger: row.trigger,
      commitHash: row.commitHash,
      // WHAT this invocation builds, stated at the claim rather than left to the
      // column default: a serve or auto-rebuild request names its compositions,
      // a plain build names this checkout's own app. The CLI is handed the same
      // ids on argv, so the row and the process cannot disagree about what ran.
      targets: row.targets,
      pid: process.pid,
      namespace,
    });
  };
  try {
    await insert();
    return true;
  } catch (err) {
    if (!isInflightViolation(err)) throw err;
  }
  if (!(await settleDeadInflightRun(db, namespace))) return false;
  try {
    await insert();
    return true;
  } catch (err) {
    if (isInflightViolation(err)) return false;
    throw err;
  }
}

/**
 * Every build this namespace launched that has not been stamped with an outcome.
 *
 * **Scoped to `namespace`, which is not optional.** A worktree DB is a fork of
 * main's and inherits its rows, so an unscoped read would hand the reconciler
 * another machine's builds — to adopt, to tail transcripts that do not exist
 * here, and to close with an outcome nobody in this namespace observed. That is
 * the phantom "Build failed" the old reconciler's own docblock warns about.
 */
export async function listUnfinished(): Promise<readonly UnfinishedRun[]> {
  const rows = await db
    .select({ id: _buildRuns.id, pid: _buildRuns.pid })
    .from(_buildRuns)
    .where(
      and(
        isNull(_buildRuns.finishedAt),
        eq(_buildRuns.namespace, runtimeNamespace()),
      ),
    );
  return rows.map((row) => ({ runId: row.id, pid: row.pid }));
}

/** Record the pid of the detached `./singularity build` now serving this run. */
export async function setPid(buildId: string, pid: number): Promise<void> {
  await db
    .update(_buildRuns)
    .set({ pid })
    .where(eq(_buildRuns.id, buildRunIdKind.key(buildId)));
}

/**
 * Stamp this run's terminal outcome if the row is still open — the whole of the
 * supervised job's `closeRow`, and nothing else.
 *
 * A bare, idempotent, first-writer-wins write. It runs inside the supervised-run
 * reconciler of **every** backend that sees the exit marker land, including one
 * that knows nothing about the workflow that started the build, which is exactly
 * what keeps a build whose workflow died from holding `build_runs_inflight_uniq`
 * against every future build of this namespace. The bell, the deployment notify
 * and the convergence reconcile are the workflow's to run exactly once, and live
 * in {@link onBuildEnded}.
 *
 * `WHERE finished_at IS NULL` because `./singularity build` closes its own row
 * right after the health probe, ~100s before its child exits: the CLI is the
 * authoritative first writer and this is usually a no-op.
 */
export async function closeBuildRow(
  buildId: string,
  terminal: RunTerminal,
): Promise<void> {
  await db
    .update(_buildRuns)
    .set({ finishedAt: terminal.finishedAt, exitCode: terminal.exitCode })
    .where(
      and(
        eq(_buildRuns.id, buildRunIdKind.key(buildId)),
        isNull(_buildRuns.finishedAt),
      ),
    );
  // The close rule decided this run ENDED (its marker, or an empty process
  // group after a hard kill), so nothing is left to write any artifact of it —
  // the `onRunTerminal` edge for this backend. Usually a repeat of the marker
  // watcher's announcement; the one it alone reaches is the hard kill, which
  // leaves no marker to watch.
  announceRunTerminal(buildId);
}

/**
 * An auto-build has claimed the slot — ring the "started" bell.
 *
 * Rung at the CLAIM rather than after the spawn, which is where it used to be:
 * the supervised job's spawn step is the wrapper's, and the claim is the last
 * moment this plugin owns before the child exists. The claim is also what the
 * bell is really about — it is the point at which this backend committed to
 * running a build and no other one can start.
 *
 * Only `auto`. A manual build already has the button that started it as its
 * feedback; a bell would be telling the user what they just did.
 */
export async function notifyBuildStarted(
  buildId: string,
  targets: string[],
): Promise<void> {
  // An auto-run is no longer always a push rebuilding this checkout's own app:
  // a served composition drifting past its rate limit mints one too, and a bell
  // that said "triggered by a new push" for a weekly cadence would be a lie.
  // The distinction is `isMainCompositionBuild`, never a literal.
  const plain = isMainCompositionBuild(targets);
  await recordNotification({
    type: "build",
    title: plain ? "Auto-build started" : "Auto-rebuild started",
    description: plain
      ? `Triggered by a new push (${buildId})`
      : `Rebuilding ${targets.join(", ")} (${buildId})`,
    variant: "info",
    dedupeKey: `build-start:${buildId}`,
  });
}

/**
 * A build has ended — THE terminal edge, and everything that is not the row's
 * own outcome stamp.
 *
 * **The row is already closed by the time this runs, and that is the ordinary
 * case rather than an edge.** Two writers get there first: `./singularity build`
 * stamps its own row right after the health probe (~100s before its child
 * exits), and failing that the supervised job's `closeRow` runs in the
 * reconciler *before* the announcement that resumes the workflow. So nothing
 * here is gated on `finished_at IS NULL`, and the row is read BACK rather than
 * assumed — the bell describes the outcome the ledger carries, whoever wrote it.
 *
 * **This is the repair the migration to a supervised run bought, and it is worth
 * stating with the measurement.** `./singularity build` restarts the very
 * backend that spawned it, so the process that used to hold `await proc.exited`
 * was routinely killed before the build finished, and everything after that
 * await went with it. On `main`: 33 `Auto-build started` bells against **2**
 * `Build succeeded` bells, ever. Now the workflow that owns the build is durable
 * and resumes in whichever backend is alive when the exit marker lands, so a
 * build that outlives three restarts still reaches its own verdict.
 *
 * **Idempotent, because a job retry re-runs it.** Both notifications carry a
 * `dedupeKey`, `deploymentServed.notify()` is a signal rather than a write,
 * and `reconcileDeployment` is a stateless re-derivation whose debounce is a
 * singleton — so running this twice costs one redundant wakeup and changes
 * nothing.
 */
export async function onBuildEnded(buildId: string): Promise<void> {
  const [row] = await db
    .select({
      startedAt: _buildRuns.startedAt,
      finishedAt: _buildRuns.finishedAt,
      exitCode: _buildRuns.exitCode,
      commitHash: _buildRuns.commitHash,
    })
    .from(_buildRuns)
    .where(eq(_buildRuns.id, buildRunIdKind.key(buildId)));
  // No row means the ledger no longer has this build — a hand-deleted row, or a
  // retention sweep. Nothing to describe; the reconcile below still runs.
  if (row !== undefined) await notifyBuildFinished(buildId, row);

  // The workflow's own observation that the run ended — the `onRunTerminal`
  // edge for a hard-killed run no reconciler in this process was tracking.
  announceRunTerminal(buildId);

  // The dist has been republished and the ledger row is closed, so the
  // deployment description has changed on both axes it can change on.
  deploymentServed.notify();
  // The "a build reached terminal" convergence edge, and the single remaining
  // copy of it. It terminates because the row it reads was closed BEFORE this
  // ran: `lastClosedAttempt` sees this build's own commit as an attempt, so
  // `wantsBuild` does not immediately ask for the same build again.
  await reconcileDeployment();
}

/**
 * The bell for a finished build, in the status vocabulary the run's own badge
 * uses.
 *
 * Every arm reads `buildStatusOf`, never a raw exit code, so the notification can
 * never disagree with the badge on the run's page. Four of the six statuses are
 * not defects and must not read as alarms — `superseded` (the tree moved under
 * it), `killed` (a signal from outside says nothing about the code) and
 * `interrupted` (its process vanished without recording anything) each get their
 * own sentence.
 *
 * `RunTerminal.signalCode` is deliberately NOT consulted here, and reading the
 * status instead is not the banned `exitCode > 128` inference — but only
 * because of a precondition that has to hold and is written down where the rule
 * lives (`BUILD_EXIT_SIGNAL_BASE`): **these codes are first-party.**
 * `./singularity build` installs `installFatalSignalExit` and CHOOSES
 * `128 + signo` for itself, having caught the signal, so the number is a record
 * the build wrote rather than a wait status somebody decoded. If
 * `build_runs.exit_code` ever carries a status this repo did not author, that
 * stops being true and the shim's observed `signalCode` is what must be read.
 */
async function notifyBuildFinished(
  buildId: string,
  row: {
    startedAt: Date;
    finishedAt: Date | null;
    exitCode: number | null;
    commitHash: string | null;
  },
): Promise<void> {
  const linkTo = buildDetailRoute.link(agentManagerApp, { runId: buildId });
  const seconds = Math.round(
    ((row.finishedAt ?? new Date()).getTime() - row.startedAt.getTime()) / 1000,
  );
  const dedupeKey = `build-finish:${buildId}`;
  const status = buildStatusOf(row);
  if (status === "success") {
    await recordNotification({
      type: "build",
      title: "Build succeeded",
      description: `Completed in ${seconds}s`,
      variant: "success",
      linkTo,
      dedupeKey,
    });
    return;
  }
  if (status === "superseded") {
    // Not a failure and not an alarm: the tree moved under this build, so it had
    // nothing left to be a verdict about. The reconcile mints the rebuild.
    await recordNotification({
      type: "build",
      title: "Build superseded",
      description: `${row.commitHash?.slice(0, 9) ?? "the built commit"} was replaced mid-build — rebuilding`,
      variant: "info",
      linkTo,
      dedupeKey,
    });
    return;
  }
  // `buildStatusOf` returns `killed` only for a non-null code above the signal
  // base, so the narrowing is a restatement rather than a guard — written out
  // because `killedSignalName` takes a number and a `?? 0` default here would
  // name a signal nobody sent.
  if (status === "killed" && row.exitCode !== null) {
    // Also not a failure: a signal arrived from outside the build — a human, a
    // supervisor, another agent — which says nothing about the code.
    await recordNotification({
      type: "build",
      title: "Build ended from outside",
      description: `${killedSignalName(row.exitCode)} arrived after ${seconds}s — see the run for who sent it`,
      variant: "info",
      linkTo,
      dedupeKey,
    });
    return;
  }
  if (status === "interrupted") {
    // The supervised-run hard-kill sentinel: no exit marker at all, which only a
    // SIGKILL (or the machine going down) can produce, since every other death
    // runs the shim's trap. It never refused and never reported a failure, so it
    // is not an alarm either — but unlike `killed` there is no signal anyone
    // observed, and the sentence must not name one.
    await recordNotification({
      type: "build",
      title: "Build interrupted",
      description: `The build's process disappeared after ${seconds}s without recording an outcome`,
      variant: "info",
      linkTo,
      dedupeKey,
    });
    return;
  }
  await recordNotification({
    type: "build",
    title: "Build failed",
    description: `Exited with code ${row.exitCode} after ${seconds}s`,
    variant: "error",
    linkTo,
    dedupeKey,
  });
}
