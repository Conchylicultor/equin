import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { decideBuilds } from "./wants-build";
import { buildJob } from "./run-build";

// Trailing edge of the auto-build debounce: `reconcileDeployment` re-enqueues
// this singleton with a fresh runAt at every edge, so a burst collapses into the
// one run that fires once the window goes quiet.
export const buildRunDebouncedJob = defineJob({
  name: "build.run.debounced",
  description:
    "Starts the automatic build once a burst of changes goes quiet, so a burst yields one build.",
  // instant, and honestly so: this run decides and enqueues, and the build
  // itself is a separate workflow (`build.run.supervised`) that spawns a
  // detached child and suspends. Nothing here holds a slot for the length of a
  // build.
  hold: "instant",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  run: async () => {
    // Re-derived here, not trusted from whenever the enqueue happened. The state
    // can have converged in the debounce window (another backend's build landed,
    // autoBuild was turned off), and re-asking is what makes the debounce a pure
    // coalescing optimisation rather than a correctness mechanism.
    const decision = await decideBuilds(new Date());
    // MAIN FIRST, and only one of the two per wakeup. The build's claim is a
    // single durable in-flight slot and is deliberately target-blind, so the
    // second request would be dropped anyway — this makes the priority explicit
    // rather than leaving it to which line runs first. Nothing is lost by
    // yielding: the main build's own terminal edge reconciles again, and the
    // composition it deferred is re-derived there and built then.
    //
    // Enqueueing while a build is already in flight is safe: the claiming INSERT
    // against `build_runs_inflight_uniq` is what wins or loses, and the loser's
    // handler returns without spawning anything.
    if (decision.main) {
      await buildJob.enqueue({ trigger: "auto" });
      return;
    }
    // ONE invocation with N targets, never N invocations: one install, one
    // codegen, one checks pass, one transcript, one `build_runs` row with N
    // chips. Kept separate from main's own build on purpose — a run whose
    // `targets` were `{singularity, sonata}` would not match
    // `lastClosedAttempt`'s equality predicate, so main's reconciler would
    // conclude main was never built for that commit and build it again.
    if (decision.compositions.length > 0) {
      await buildJob.enqueue({
        trigger: "auto",
        compositions: decision.compositions,
      });
    }
  },
});
