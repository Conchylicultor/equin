import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { reconcileDeployment } from "./reconcile";

/**
 * The clock edge of the convergence loop.
 *
 * Main's own auto-build never needed one: a push moves `refs/heads/main`, and
 * `refAdvanced` is a real signal to hang the reconcile off. A CADENCE has no
 * such signal — "an hour has passed" is not something the repo emits — so this
 * is the one edge that has to be time-driven.
 *
 * A `defineJob` schedule, never an in-process timer: the repo's no-polling rule
 * makes the queue the sanctioned home for time-driven work, and a queued run
 * survives the restart a build does to this very backend, which an interval
 * would not.
 *
 * Fifteen minutes, for the same reason `events.refresh-tick` picks it: the tick
 * decides nothing, so its period only has to be fine enough that the finest
 * cadence a composition can pick is not visibly late — and that is `hourly`.
 * A finer tick would buy nothing; a coarser one would make "hourly" mean "up to
 * an hour and a half".
 *
 * `perWorktree` is deliberately UNSET ⇒ main only, matching the scope
 * `decideBuilds` enforces anyway. A per-worktree schedule would have every live
 * agent worktree waking up to rebuild the same compositions.
 *
 * Its whole body is a WAKEUP. Whether anything is due — the mode, the rate
 * limit, the commit comparison, the termination clause — is re-derived inside
 * `decideBuilds` from durable state, so this job carries no state of its own and
 * a tick that is missed, retried or duplicated cannot change the outcome.
 */
export const compositionTickJob = defineJob({
  name: "build.composition-tick",
  description:
    "Re-checks whether compositions are out of date and schedules a build if so.",
  // instant: this handler re-derives the decision and at most re-enqueues the
  // debounced job. The build it may cause runs in `build.run.debounced`.
  hold: "instant",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "*/15 * * * *" },
  maxAttempts: 3,
  run: async () => {
    await reconcileDeployment();
  },
});
