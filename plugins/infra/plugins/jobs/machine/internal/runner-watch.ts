import type { WorkerEvents } from "graphile-worker";
import { reportServerFatalSync } from "@plugins/framework/plugins/server-core/core";
import type { RunnerSpec } from "../../core/hold";
import {
  JOB_RUNNER_DIED_KIND,
  type JobRunnerDiedReport,
} from "../../server/internal/runner-died";
import {
  LATCH_WINDOW_MS,
  MAX_TRIPS_PER_WINDOW,
  recordTrip,
} from "./exit-latch";

// A RUNNER THAT STOPS ON ITS OWN NEVER COMES BACK, AND NOTHING ELSE NOTICES.
//
// graphile answers one failed completion batch, or one worker exiting early, by
// shutting down that whole runner, and it does not restart it. The backend stays
// up and the other runners keep working, so the queue looks merely slow. On
// 2026-11-01 one deadlock stopped main's `wide` runner: no `minutes` job ran and,
// because `wide` carries the cron items, no scheduled job fired either — every
// monitor that could have reported it included — until someone looked.
//
// `runner.promise` is the signal, and it RESOLVES on that death: graphile
// swallows the pool's error (`dist/runner.js`), so a rejection handler alone
// would hear nothing. The only thing telling a death from our own shutdown is
// `isStopping`. The reason arrives separately, on `pool:fatalError`.

/**
 * Call `onDeath` if this runner stops while we did not ask it to. Listens before
 * anything can fail, so attach it right after `run()`. Exported apart from the
 * exit so the decision is testable without one.
 */
export function watchRunner(opts: {
  runner: { promise: Promise<void> };
  events: WorkerEvents;
  isStopping: () => boolean;
  onDeath: (reason: string) => void;
}): void {
  const { runner, events, isStopping, onDeath } = opts;
  let reason = "graphile stopped the runner and reported no fatal error";
  events.on("pool:fatalError", ({ action, error }) => {
    reason = `${action}: ${String(error)}`;
  });
  const settled = (): void => {
    if (!isStopping()) onDeath(reason);
  };
  void runner.promise.then(settled, (err: unknown) => {
    reason = String(err);
    settled();
  });
}

/**
 * A runner died: file the report synchronously and exit, so the next boot starts
 * every runner and the cron schedule again. Postgres drops the dead backend's
 * advisory locks, so the sweeper reclaims whatever it was holding.
 *
 * Every runner counts, not only the widest: a narrower one's work still reaches
 * the wider runners, but its reserved capacity is gone for the life of the
 * process, and a restart returns it. The restart is lazy, as for the floor: the
 * next request through the gateway starts a fresh backend.
 *
 * Returns only when the anti-loop latch suppressed the exit.
 */
export async function exitForDeadRunner(
  spec: RunnerSpec,
  carriesCron: boolean,
  reason: string,
): Promise<void> {
  const trips = await recordTrip();
  const suppressed = trips > MAX_TRIPS_PER_WINDOW;
  const report: JobRunnerDiedReport = {
    action: suppressed ? "degraded" : "crashed",
    runnerId: spec.id,
    serves: [...spec.serves],
    concurrency: spec.concurrency,
    carriesCron,
    reason,
    tripsThisWindow: trips,
    maxTripsPerWindow: MAX_TRIPS_PER_WINDOW,
    windowMs: LATCH_WINDOW_MS,
  };
  const summary = `[jobs] the ${spec.id} runner stopped on its own (${reason})`;

  if (suppressed) {
    console.error(
      `${summary}. STAYING UP: this worktree already exited ${trips - 1} time(s) within the last ${LATCH_WINDOW_MS} ms, so another restart would not fix it.`,
    );
    reportServerFatalSync({
      kind: JOB_RUNNER_DIED_KIND,
      message: `${spec.id} runner died — restart suppressed by the anti-loop latch`,
      data: report,
    });
    return;
  }

  console.error(`${summary}. Exiting so the next boot restarts it.`);
  // Synchronous by contract: the durable line is written before this returns,
  // which is the only reason a report can exist at all on this path.
  reportServerFatalSync({
    kind: JOB_RUNNER_DIED_KIND,
    message: `${spec.id} runner died — backend exited`,
    data: report,
  });
  process.exit(1);
}
