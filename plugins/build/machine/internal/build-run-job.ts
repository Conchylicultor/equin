import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { reconcileDeployment } from "./reconcile";

export const buildRunJob = defineJob({
  name: "build.run",
  description:
    "Decides whether any composition needs rebuilding when the deployment target moves, and schedules the build.",
  // instant: this handler re-derives the build decision (a memoized deployment
  // read plus one indexed ledger read per SERVED composition, in `decideBuilds`)
  // and at most re-enqueues the debounced job. The build it eventually causes
  // runs in `build.run.debounced`, not in this slot.
  hold: "instant",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  // The "target moved" edge, bound to the durable `git.refAdvanced` trigger in
  // the server barrel. Durable on purpose: a `defineRefReaction` would run
  // in-process on every backend with no retry, whereas a queued job survives a
  // restart and is retried if it fails — and a restart is exactly what a build
  // does to this process.
  //
  // The decision itself lives in `reconcileDeployment`, which re-derives it from
  // durable state rather than from the payload of the event that woke it. So a
  // ref advance this job never saw (a push during a restart) is not lost — the
  // next edge sees the same state and reaches the same conclusion.
  run: async () => {
    await reconcileDeployment();
  },
});
