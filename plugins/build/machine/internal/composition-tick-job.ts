import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { requestConvergence } from "./request-convergence";

/**
 * The clock edge of main's auto-build loop.
 *
 * Main's own app never needed one: a push moves `refs/heads/main`, and the
 * gateway hangs a convergence run off that. A served composition's CADENCE has
 * no such signal — "an hour has passed" is not something the repo emits — so
 * this is the one edge that has to be time-driven.
 *
 * A `defineJob` schedule, never an in-process timer: the repo's no-polling rule
 * makes the queue the sanctioned home for time-driven work.
 *
 * Fifteen minutes, for the same reason `events.refresh-tick` picks it: the tick
 * decides nothing, so its period only has to be fine enough that the finest
 * cadence a composition can pick is not visibly late — and that is `hourly`.
 *
 * `perWorktree` is deliberately UNSET ⇒ main only: auto-build follows main.
 *
 * Its whole body is a WAKEUP, handed to the gateway: whether anything is due —
 * the mode, the rate limit, the commit comparison, the termination clause — is
 * re-derived by the convergence run (`build/converge`) from durable state, so
 * a tick that is missed, retried or duplicated cannot change the outcome. It
 * is an optional edge: while main's backend is down no tick fires, and the
 * compositions wait for the next push or the next tick — main's own app does
 * not depend on it.
 */
export const compositionTickJob = defineJob({
  name: "build.composition-tick",
  description:
    "Asks the gateway to re-check whether served compositions are due a rebuild.",
  // instant: one request to the gateway, which answers before it spawns.
  hold: "instant",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "*/15 * * * *" },
  maxAttempts: 3,
  run: async () => {
    await requestConvergence("composition tick");
  },
});
