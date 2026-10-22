import { buildRunDebouncedJob } from "./build-run-debounced-job";
import { decideBuilds } from "./wants-build";

/**
 * Trailing-debounce window: coalesce a burst of near-sequential pushes into one
 * build+restart. Every reconcile re-enqueues the singleton debounced job with a
 * fresh runAt, pushing the fire time forward until the pushes go quiet.
 *
 * Purely an optimisation. The debounced job re-derives the decision before it
 * spawns anything, so losing or duplicating a debounce costs a wasted wakeup,
 * never a wrong build and never a missed one.
 */
const DEBOUNCE_MS = 5_000;

/**
 * Auto-build is a CONVERGENCE loop on "this checkout's HEAD is what is
 * deployed", not a queue of push events. A build request DROPS when it arrives
 * while a build is in flight — the claiming INSERT against
 * `build_runs_inflight_uniq` loses, and the handler returns without spawning
 * anything — and a push landing mid-build is precisely when one does, so the
 * request cannot be remembered, it has to be re-derived. This is that
 * re-derivation.
 *
 * **It takes no argument.** That is the whole point. The old design carried a
 * baseline (the commit the finished build was for) from the caller that started
 * the build to the caller that saw it end — but on a main auto-build those are
 * not the same process: the build restarts the very backend that spawned it, so
 * the baseline died with it. Here there is nothing to carry, so nothing can be
 * lost.
 *
 * Called at five edges — the target moving (`buildRunJob`, on the durable
 * `refAdvanced` trigger), a build reaching terminal (the build job's `onEnded`,
 * in `run-state.ts`), this backend starting (`onReady`), the `compositions`
 * config changing, and the `build.composition-tick` cron.
 *
 * The terminal edge used to be TWO — the spawning call's `finally` for a build
 * whose starting backend survived, and `watchInflightBuild`'s `settle` for one
 * it did not. A build restarts the backend that spawned it, so the first almost
 * never fired; they are now one durable workflow that resumes in whichever
 * backend is alive when the exit marker lands.
 *
 * Because the decision is stateless and idempotent (the
 * `build_runs_inflight_uniq` partial index already makes a redundant trigger a
 * no-op), an extra edge is free and a missed edge degrades to "converges at the
 * next edge". Under the old design every net was load-bearing, which is why all
 * three failing at once produced a permanent miss (2026-08-19).
 *
 * The loop now covers the compositions this checkout SERVES as well as its own
 * app: a served namespace runs the dist and the server tree of whatever commit
 * last happened to build it, so without this it drifts silently. It converges by
 * the same mechanism and inherits the same guarantees — the two extra edges
 * above exist only because a cadence has no push to hang off, and the last
 * clause the compositions add is a rate limit, never a queue.
 */
export async function reconcileDeployment(): Promise<void> {
  const decision = await decideBuilds(new Date());
  if (!decision.main && decision.compositions.length === 0) return;
  await buildRunDebouncedJob.enqueue(
    {},
    { runAt: new Date(Date.now() + DEBOUNCE_MS) },
  );
}
