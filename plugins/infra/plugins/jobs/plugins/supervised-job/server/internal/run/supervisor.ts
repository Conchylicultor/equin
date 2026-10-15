import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { basename } from "node:path";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import {
  defineFileWatcher,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import {
  pruneWorktreeRunArtifacts,
  RUN_TERMINAL_SUFFIX,
  RUN_TRANSCRIPT_SUFFIX,
  worktreeArtifacts,
} from "@plugins/infra/plugins/paths/server";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import {
  assertRunId,
  observeRun,
  readRunTerminal,
  supervisedArgv,
} from "../../../core";
import {
  assertRegistered,
  getSupervisedRunKind,
  getSupervisedRunKinds,
  type SupervisedRunKind,
} from "./registry";
import { createTranscriptTail, type TranscriptTail } from "./tail";

/**
 * How often the watcher re-derives every kind's unfinished set while any run is
 * live.
 *
 * NOT a poller, by the same argument `watch-inflight-build` makes: the timer
 * exists only while a run is unfinished and stops the instant the last one
 * closes. It covers exactly one case the filesystem cannot report — a child
 * SIGKILLed, which writes no marker, so no event will ever arrive to say the
 * run ended. Everything else settles in well under a second off a real event.
 */
const RECONCILE_MS = 60_000;

/**
 * The runs-dir watcher: one instance, open only while a run is live (see
 * `syncWatcher`).
 */
export const supervisedRunWatcher = defineFileWatcher({
  name: "supervised-job.runs-dir",
  description:
    "While a detached child runs, follows its transcript and exit marker in the runs directory to stream its output live and settle the run the moment it ends.",
  // A transcript grows continuously, so the debounce is what turns a build's
  // thousands of writes into a bounded number of pumps. Each pump then reads
  // everything that accumulated, so nothing is lost by waiting.
  extensions: [RUN_TRANSCRIPT_SUFFIX, RUN_TERMINAL_SUFFIX],
  // The child writes its transcript through ONE descriptor it holds open for
  // the whole run. macOS FSEvents reports that file's changes only when the
  // descriptor closes — at exit — so without this the tail was pumped once, at
  // the end, and a live run published nothing until it finished. Its cost (one
  // descriptor per entry, kqueue on darwin) is bounded here: the runs dir is
  // flat and capped by `pruneWorktreeRunArtifacts`, and the watcher exists only
  // while a run is live.
  writesWhileOpen: true,
  reconcileMs: RECONCILE_MS,
});

/** A run this process is currently tailing. */
interface LiveRun {
  readonly kind: SupervisedRunKind;
  readonly runId: string;
  readonly tail: TranscriptTail;
  /**
   * The pid this process last knew for the run — from the spawn, or refreshed
   * from the ledger on every reconcile pass.
   *
   * Remembered rather than re-read, because the one case that needs it is the
   * one where the ledger no longer answers: a run whose row the caller's own CLI
   * has already stamped is gone from `listUnfinished`, and "is its child still
   * alive?" is exactly the question left to ask about it (see
   * `reconcileSupervisedRuns`). Null when the run was claimed but never got a
   * pid — which reads as dead, the same as everywhere else.
   *
   * Once the spawn has happened this is the shim's pid, which is also the id of
   * the run's process group; liveness asks about the whole group
   * (`isRunAlive`), so a shim killed alone does not end a run whose worker is
   * still going.
   */
  pid: number | null;
}

const live = new Map<string, LiveRun>();
let watcher: FileWatcher | null = null;
// The in-flight `supervisedRunWatcher.start`, so two concurrent starts share one
// subscription instead of racing to leave an orphan nothing can stop.
let watcherStarting: Promise<void> | null = null;

/**
 * The live-set key. `:` separates the halves unambiguously because a kind id is
 * alphanumeric and a run id never contains one, so no two runs can collide.
 */
const liveKey = (kindId: string, runId: string): string => `${kindId}:${runId}`;

/**
 * Which run an artifact filename belongs to, or null if it is not one.
 *
 * The inverse of `worktreeArtifacts.runTranscript` / `runTerminal`, which is
 * why the suffixes come FROM `paths` rather than being spelled again here: this
 * is the one reader that goes backwards from a filename, so a private copy of
 * the marker suffix would be the single place a layout change could silently
 * stop every run from ever being closed.
 *
 * The kind/run split is the FIRST `-`, which is exact because a kind id may not
 * contain one (`assertRunKindId`). The kind is then resolved through the
 * registry rather than trusted, so a stray file in the directory cannot mint a
 * run for a kind nobody registered.
 */
function parseArtifactName(
  filename: string,
): { kind: SupervisedRunKind; runId: string; isTerminal: boolean } | null {
  const isTerminal = filename.endsWith(RUN_TERMINAL_SUFFIX);
  const stem = isTerminal
    ? filename.slice(0, -RUN_TERMINAL_SUFFIX.length)
    : filename.endsWith(RUN_TRANSCRIPT_SUFFIX)
      ? filename.slice(0, -RUN_TRANSCRIPT_SUFFIX.length)
      : null;
  if (stem === null) return null;
  const dash = stem.indexOf("-");
  if (dash <= 0) return null;
  const kind = getSupervisedRunKind(stem.slice(0, dash));
  const runId = stem.slice(dash + 1);
  if (kind === undefined || runId === "") return null;
  return { kind, runId, isTerminal };
}

/**
 * Adopt a run into the live set, starting its transcript tail from the top.
 *
 * Offset 0 for both callers, and for the same reason in each: at spawn the file
 * is new, and at boot the channel's ring buffer is process memory that died
 * with the last backend — so republishing the whole transcript is what puts the
 * run back on screen still scrolling, rather than showing an empty log beside a
 * "running" badge.
 */
function track(
  kind: SupervisedRunKind,
  runId: string,
  pid: number | null,
): LiveRun {
  const tail = createTranscriptTail({
    path: worktreeArtifacts.runTranscript(runtimeNamespace(), kind.id, runId),
    fromOffset: 0,
    publish: (lines) => {
      // No `stream` argument, so every line publishes as the channel's default.
      // The classification is genuinely gone, not withheld: stdout and stderr
      // share one fd (`2>&1`) so interleaving order survives and the split does
      // not. Two files with two tailers would keep the split and destroy the
      // order, which is the worse trade for a transcript people read top to
      // bottom.
      kind.spec.channel.publishAll(lines.map((line) => ({ line })));
    },
  });
  const run: LiveRun = { kind, runId, tail, pid };
  live.set(liveKey(kind.id, runId), run);
  return run;
}

/**
 * Stop tailing a run and drop it from the live set.
 *
 * Reached ONLY from {@link settleRun}, and that is a rule rather than a
 * coincidence: untracking is what stops the tail and — once the last run goes —
 * tears down the watcher, so doing it on any condition weaker than "this run has
 * ended" silently strands whatever was still to come. It did once, on the
 * ledger's say-so; see the second loop of `reconcileSupervisedRuns`.
 */
function untrack(run: LiveRun): void {
  run.tail.stop();
  live.delete(liveKey(run.kind.id, run.runId));
}

/**
 * Apply the close rule to one run, and close it when it has reached a terminal.
 *
 * The rule itself is {@link observeRun} in this plugin's `core/` — the one
 * statement of it, shared with the job workflow's `awaitSupervisedRun`, so the
 * reconciler and a waiting workflow cannot disagree about whether a run ended:
 *
 * ```
 * close?  =  !(terminal == null && isRunAlive(pid))
 * value   =  terminal ?? { exitCode: -1, signalCode: null, finishedAt: now }
 * ```
 *
 * Liveness is the run's process GROUP, not the shim's pid (see `isRunAlive`): a
 * shim SIGKILLed alone leaves its worker running in the group, and closing the
 * run then would stop this tail one worker short of the end and release the
 * kind's in-flight lock under a live child. The run stays tracked until the
 * group is empty, and only then closes with the `-1` nobody witnessed.
 *
 * **The order of the last two statements is load-bearing: drain, then finish.**
 * `untrack` pumps the tail one final time, so every line the child wrote before
 * exiting is published before the consumer's `finish` runs — a UI that stops
 * following a finished run must not stop one pump short of the line that says
 * why it failed. And `finish` is called on EVERY path that reaches here, which
 * is why this is the only function allowed to untrack.
 */
async function settleRun(
  kind: SupervisedRunKind,
  runId: string,
  pid: number | null,
  now: Date,
): Promise<boolean> {
  const observation = observeRun(kind.id, runId, pid, now);
  if (observation.state === "running") return false;
  const run = live.get(liveKey(kind.id, runId));
  // Drain BEFORE the row closes: a UI that stops following a finished run must
  // not stop one pump short of the line that says why it failed.
  if (run !== undefined) untrack(run);
  await kind.spec.finish(runId, observation.terminal);
  return true;
}

/**
 * File a reconcile failure and carry on.
 *
 * Reported, not swallowed, and not rethrown either. This loop is the ONE
 * reconciler for every kind, so letting one broken ledger read or one corrupt
 * marker abort the pass would leave unrelated rows open — the failure mode a
 * per-plugin reconciler could not have. The report is the loud part; the
 * isolation is what keeps the blast radius at the named scope.
 */
function reportRunFailure(scope: string, err: unknown): void {
  reportServerError({
    message: `[supervised-run] reconcile failed for ${scope}: ${
      err instanceof Error ? err.message : String(err)
    }`,
    stack: err instanceof Error ? (err.stack ?? null) : null,
  });
}

/**
 * Re-derive every registered kind's unfinished set and act on each row: adopt
 * the ones still running, close the ones that have ended.
 *
 * THE reconciler, registered once by this plugin rather than once per consumer.
 * `reconcileOrphanBuilds` and `reconcileOrphanReleases` are two near-copies of
 * this loop that agree on nothing except the parts neither got wrong, and they
 * are deleted rather than generalised in place precisely because this exists.
 *
 * Idempotent and safe to call from any edge — boot, a marker landing, the
 * safety-net tick. A kind whose ledger read throws is reported and skipped, not
 * allowed to abort the pass: one plugin's broken query must not leave every
 * other kind's rows open.
 */
export async function reconcileSupervisedRuns(): Promise<void> {
  const now = new Date();
  for (const kind of getSupervisedRunKinds()) {
    try {
      const unfinished = await kind.spec.listUnfinished();
      for (const row of unfinished) {
        // Per ROW, inside the per-kind catch below. A malformed exit marker
        // throws (RunMarkerError), and that must cost exactly the one run whose
        // marker is bad: with only the outer catch, one corrupt file would
        // abort the pass before its siblings were reached and none of the
        // kind's other runs would ever close.
        try {
          const existing = live.get(liveKey(kind.id, row.runId));
          if (existing === undefined) {
            // A run this process did not start: adopt it BEFORE deciding, so
            // one that turns out to still be going is already streaming by the
            // time anyone looks, and one that has ended still gets its
            // transcript republished by `untrack`'s final drain.
            track(kind, row.runId, row.pid);
            kind.spec.onReattach?.(row.runId);
          } else {
            // The ledger is the fresher source while it still answers — a kind
            // that re-points a row at a new process (deploy's `beginLeg`) moves
            // the pid under us.
            existing.pid = row.pid;
          }
          await settleRun(kind, row.runId, row.pid, now);
        } catch (err) {
          reportRunFailure(`run ${kind.id}/${row.runId}`, err);
        }
      }
      // A run we are tailing that the ledger no longer lists — the caller's own
      // CLI stamping its own row, which is the ordinary case (build's does,
      // right after the health probe). It goes through `settleRun` like every
      // other run, NOT through a bare `untrack`, and that distinction is the
      // whole point of this block.
      //
      // **A stamped row is not a finished process.** `./singularity build`
      // closes its row after the health probe and then runs for another ~100s
      // of compose-serve tail (measured: 75.8s). Dropping it here on the
      // ledger's say-so stopped the tail mid-run — truncating the live log for
      // every kind that stamps early — and, once it was the last live run, tore
      // down the watcher, so the exit marker that landed later reached nobody
      // and `finish` was NEVER CALLED. That is a broken contract, not a build
      // quirk: `finish` is what a consumer hangs its terminal work on.
      //
      // So the condition is the run having ENDED, not its row having been
      // stamped: `settleRun` keeps it tracked while no marker exists and the
      // group is alive, and closes it the moment either changes. **The set is
      // still bounded by exactly the argument it was before** — every child
      // either writes a marker (every death but SIGKILL runs the shim's trap)
      // or its process group empties, and this pass re-checks on the same
      // timer. All that moved is WHEN a run leaves: at the first tick after its
      // child really ended, rather than at the first tick after someone wrote
      // to a table.
      const stillOpen = new Set(unfinished.map((r) => r.runId));
      for (const run of [...live.values()]) {
        if (run.kind.id !== kind.id || stillOpen.has(run.runId)) continue;
        try {
          await settleRun(kind, run.runId, run.pid, now);
        } catch (err) {
          reportRunFailure(`run ${kind.id}/${run.runId}`, err);
        }
      }
    } catch (err) {
      reportRunFailure(`kind "${kind.id}"`, err);
    }
  }
  await syncWatcher();
}

/**
 * Settle one run from its marker alone — the cheap path an exit-marker event
 * takes.
 *
 * No ledger read, because none is needed: a marker present closes the run
 * whatever the pid says, so the `pid` argument of the general rule is
 * irrelevant here. That is what keeps a busy transcript from turning every
 * filesystem event into a DB round-trip per kind.
 */
async function settleFromMarker(
  kind: SupervisedRunKind,
  runId: string,
): Promise<void> {
  if (readRunTerminal(kind.id, runId) === null) return;
  await settleRun(kind, runId, null, new Date());
  await syncWatcher();
}

/**
 * Keep exactly one watcher alive for as long as at least one run is.
 *
 * One subscription for every live run of every kind, over the single directory
 * they all write into — which is why that directory exists (see `runsDirFor`
 * in `paths`). Per-run watchers would multiply the native subscriptions by the
 * number of concurrent runs for no gain, since every event arrives on the same
 * directory anyway.
 */
async function syncWatcher(): Promise<void> {
  if (live.size === 0) {
    // Let a start already in flight finish before deciding there is nothing to
    // stop — otherwise the subscription it is about to publish into `watcher`
    // lands after this branch has read `null` and outlives every run it was
    // created for, with nothing holding a handle to stop it.
    await watcherStarting;
    if (watcher !== null) {
      const w = watcher;
      watcher = null;
      await w.stop();
    }
    return;
  }
  if (watcher !== null || watcherStarting !== null) {
    await watcherStarting;
    return;
  }
  const dir = worktreeArtifacts.runsDir(runtimeNamespace());
  mkdirSync(dir, { recursive: true });
  watcherStarting = (async () => {
    watcher = await supervisedRunWatcher.start({
      dirs: [dir],
      onChange: (events) =>
        runTracked("watch:supervised-run", () => onArtifactEvents(events)),
      onReconcile: () =>
        runTracked("watch:supervised-run:reconcile", () =>
          reconcileSupervisedRuns(),
        ),
    });
  })();
  try {
    await watcherStarting;
  } finally {
    watcherStarting = null;
  }
}

/**
 * Delete from the runs dir only while no watcher subscribe is walking it.
 *
 * The kqueue backend (`writesWhileOpen`) subscribes by listing the dir and then
 * opening every entry it listed; a file deleted between the two fails the
 * WHOLE subscribe with `error watching <runs>: No such file or directory`. The
 * prune is the only thing in this process that deletes there, and another
 * kind's run starting at the same instant pruned under a live subscribe
 * (2026-10-15: backup and worktree-cleanup.reap-stale, both scheduled at
 * 03:00). Not retried after the fact instead: a failed parcel subscribe leaves
 * its half-opened entries — and the cached listing still naming the deleted
 * file — on the shared backend, so the retry would fail the same way.
 *
 * `prune` is synchronous, and no `await` separates the loop's exit from it, so
 * no subscribe can start in between. A start that failed is its own caller's
 * error, not this one's — hence `allSettled`.
 */
async function pruneOutsideWatcherStart(prune: () => void): Promise<void> {
  while (watcherStarting !== null) await Promise.allSettled([watcherStarting]);
  prune();
}

async function onArtifactEvents(
  events: readonly { path: string }[],
): Promise<void> {
  const finished: { kind: SupervisedRunKind; runId: string }[] = [];
  for (const event of events) {
    const parsed = parseArtifactName(basename(event.path));
    if (parsed === null) continue;
    if (parsed.isTerminal) {
      finished.push({ kind: parsed.kind, runId: parsed.runId });
      continue;
    }
    // A transcript grew. Only a run we are tracking has anywhere to publish to;
    // a `.log` event for anything else is another worktree's leftover or a run
    // already settled. Pumped BEFORE any settle below, so a marker and a final
    // burst of output arriving in the same debounce window are still published
    // in order.
    live.get(liveKey(parsed.kind.id, parsed.runId))?.tail.pump();
  }
  for (const { kind, runId } of finished) await settleFromMarker(kind, runId);
}

/**
 * Globally-shared brand, so `isSupervisedSpawnError` survives module identity
 * differing between the throw and the catch (HMR, a worktree linking this
 * plugin through two paths). Same reason `SuspendSignal` and
 * `NonRetryableError` carry one.
 */
const SPAWN_ERROR_BRAND: unique symbol = Symbol.for(
  "@plugins/supervised-run:SupervisedSpawnError",
) as never;

/**
 * `startSupervisedRun` failed — and, load-bearingly, **which side of the spawn
 * it failed on**.
 *
 * A caller that has already claimed its ledger row has one compensating action
 * available (close the row, releasing the kind's in-flight lock) and it is only
 * safe on ONE side of that boundary:
 *
 * - **`childStarted: false`** — no process exists and none ever will, so the row
 *   would stay open forever with a live seeded pid and wedge the kind. Closing
 *   it is the repair.
 * - **`childStarted: true`** — `Bun.spawn` returned and the child is running; the
 *   failure was in the bookkeeping after it (the `setPid` write, the watcher).
 *   The run genuinely exists: it will write its transcript and its exit marker,
 *   and the reconciler settles it through the ordinary path. **Closing the row
 *   here would release the in-flight lock while the child is still running**, so
 *   the next enqueue claims cleanly and spawns a SECOND child — two concurrent
 *   builds against one checkout, two converges against one remote. That is
 *   precisely the overlap the partial unique index exists to prevent.
 *
 * The flag is derived from whether the pid was actually assigned, not from a
 * hand-maintained list of which call sites throw where — so it cannot drift as
 * this function grows. The original error is always the `cause`.
 */
export class SupervisedSpawnError extends Error {
  readonly [SPAWN_ERROR_BRAND] = true;
  constructor(
    message: string,
    /** Whether `Bun.spawn` had already returned a live child when this failed. */
    readonly childStarted: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SupervisedSpawnError";
  }
}

/** Brand check that survives module-identity differences. Never `instanceof`. */
export function isSupervisedSpawnError(
  err: unknown,
): err is SupervisedSpawnError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Record<symbol, unknown>)[SPAWN_ERROR_BRAND] === true
  );
}

export interface StartedRun {
  /**
   * The pid of the supervising shim, which is also the process-group id — the
   * child is inside it, so this is the handle {@link killSupervisedRun} signals,
   * and the group `isRunAlive` probes: the run is alive while ANY process of the
   * group is, not merely while the shim is.
   */
  pid: number;
}

/**
 * Start one supervised run: spawn `argv` detached, with its merged output going
 * to this run's transcript file, and begin publishing that file to the kind's
 * channel.
 *
 * The caller must have claimed its ledger row FIRST, seeded with a live pid
 * (`process.pid`, this backend's own). That ordering is build's and it is
 * subtle enough to be worth restating: the claiming INSERT — guarded by a
 * partial unique index on the kind's own scope `WHERE finished_at IS NULL` — is
 * what wins or loses the race between two callers, so a check-then-act before
 * the insert has a TOCTOU window and a lock built on it does not hold. The
 * seeded pid is what keeps the freshly-claimed row from looking like an orphan
 * in the moment before the child's pid is known.
 *
 * Three things about the spawn are load-bearing:
 *
 * - **`detached: true`** puts the child in its own process group. The gateway
 *   hot-restarts a backend by signalling its whole process group, so a plain
 *   child shares that group and dies with its parent. That is the entire
 *   2026-08-28 deploy incident: an unrelated `./singularity build` of main
 *   restarted the backend and took a running deploy with it, 0.9 s after spawn.
 * - **stdout and stderr both point at the SAME fd**, which is `2>&1` at the
 *   kernel level. Interleaving order is preserved; the per-line stdout/stderr
 *   classification is not (see `track`'s publish).
 * - **no piped stdio anywhere**, which is why this file is a sanctioned
 *   `spawn-safety/no-raw-bun-spawn` site: `spawnCaptured` captures into temp
 *   files it reads AFTER exit, and this child is meant to outlive the call.
 */
export async function startSupervisedRun(
  kind: SupervisedRunKind,
  opts: {
    runId: string;
    argv: readonly string[];
    cwd?: string;
    /**
     * Entries ADDED to this backend's own environment — deliberately not the
     * full replacement `spawnCaptured`'s `env` is. A supervised child is a long
     * job started from inside the app (a build, a deploy) and every consumer
     * wants the backend's environment as its base; the name says which of the
     * two contracts this is, so the neighbouring primitive's meaning cannot be
     * assumed here by mistake.
     */
    envOverrides?: Record<string, string>;
  },
): Promise<StartedRun> {
  // `null` until `Bun.spawn` returns, which is what makes the boundary in
  // `SupervisedSpawnError.childStarted` an OBSERVATION rather than a
  // classification of error sites.
  let pid: number | null = null;
  try {
    return await startOrThrow();
  } catch (err) {
    throw new SupervisedSpawnError(
      `[supervised-run] ${kind.id}: run ${opts.runId} failed to start ` +
        `${pid === null ? "BEFORE" : "AFTER"} its child was spawned: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      pid !== null,
      { cause: err },
    );
  }

  async function startOrThrow(): Promise<StartedRun> {
    assertRegistered(kind);
    assertRunId(kind.id, opts.runId);

    const worktree = runtimeNamespace();
    const transcriptPath = worktreeArtifacts.runTranscript(
      worktree,
      kind.id,
      opts.runId,
    );
    const terminalPath = worktreeArtifacts.runTerminal(
      worktree,
      kind.id,
      opts.runId,
    );
    // A marker already sitting there means this run id has been used before, and
    // the new run would be read as finished the instant anything reconciled it.
    // Loud at the caller, where the id was minted.
    if (existsSync(terminalPath)) {
      throw new Error(
        `[supervised-run] ${kind.id}: run id ${JSON.stringify(opts.runId)} already ` +
          `has an exit marker at ${terminalPath} — run ids must be unique.`,
      );
    }
    mkdirSync(worktreeArtifacts.runsDir(worktree), { recursive: true });

    // Append, not truncate: `"a"` also creates the file, so the transcript exists
    // before the child does and the tail has something to open from the first
    // pump onwards.
    const fd = openSync(transcriptPath, "a");
    try {
      const shim = supervisedArgv(opts.argv, terminalPath);
      const proc = Bun.spawn(shim.argv, {
        cwd: opts.cwd,
        stdin: "ignore",
        stdout: fd,
        stderr: fd,
        detached: true,
        env: { ...process.env, ...shim.env, ...opts.envOverrides },
      });
      pid = proc.pid;
    } finally {
      // The child holds its own duplicate of the descriptor, so the parent's copy
      // has done its job the moment the spawn returns. Closing it in `finally`
      // means a failed spawn does not leak one either.
      closeSync(fd);
    }

    // Cap this kind's artifacts now that the newest set exists — the same
    // "writing a new set trims the old ones" rule the build and release prunes
    // follow, so there is no sweeper to schedule and nothing to forget.
    await pruneOutsideWatcherStart(() =>
      pruneWorktreeRunArtifacts(worktree, kind.id),
    );

    await kind.spec.setPid(opts.runId, pid);
    track(kind, opts.runId, pid);
    await syncWatcher();
    // Close the subscribe race: a very short run can finish while
    // `parcel.subscribe` is still setting up, and the subscription only reports
    // events from after it completes. One settle here catches that missed write.
    await settleFromMarker(kind, opts.runId);
    return { pid };
  }
}

/** What signalling a run actually did. Never a bare boolean — the arms differ. */
export type KillOutcome =
  | { readonly ok: true; readonly pid: number }
  /** The run is not in the kind's unfinished set: already stamped, or never claimed. */
  | { readonly ok: false; readonly reason: "not-running" }
  /** Claimed, but no pid was ever recorded — nothing to signal. */
  | { readonly ok: false; readonly reason: "no-pid" }
  /** The pid was gone by the time we signalled; the reconciler will close the row. */
  | { readonly ok: false; readonly reason: "already-exited" }
  /**
   * The row still holds the pid its claiming backend seeded it with — THIS
   * process — so its child is not spawned yet. Signalling `-pid` would hit this
   * backend's own process group.
   */
  | { readonly ok: false; readonly reason: "not-spawned" };

/**
 * Cancel a supervised run by signalling it.
 *
 * Cancellation of an out-of-process run is "signal a pid", not "abort a
 * promise", and this exists so each consumer does not reinvent that — including
 * the part that is easy to get wrong.
 *
 * **The signal goes to the process GROUP** (`-pid`), not to the shim alone. The
 * shim does not forward signals to its child, so signalling it by itself would
 * kill the supervisor and leave the real work running, reparented and
 * untracked. Signalling the group reaches both: the child dies, and the shim's
 * `wait` returns `128+signo` and records it — so a cancelled run gets a true 143
 * on its row rather than the `-1` a lost supervisor would have produced. The
 * group exists because the spawn is `detached`.
 *
 * The pid comes from the kind's ledger, never from an in-memory map, so this
 * works on a run started by a previous backend.
 */
export async function killSupervisedRun(
  kind: SupervisedRunKind,
  runId: string,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<KillOutcome> {
  assertRegistered(kind);
  const row = (await kind.spec.listUnfinished()).find((r) => r.runId === runId);
  if (row === undefined) return { ok: false, reason: "not-running" };
  if (row.pid === null) return { ok: false, reason: "no-pid" };
  if (row.pid === process.pid) return { ok: false, reason: "not-spawned" };
  try {
    process.kill(-row.pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH")
      return { ok: false, reason: "already-exited" };
    throw err;
  }
  return { ok: true, pid: row.pid };
}
