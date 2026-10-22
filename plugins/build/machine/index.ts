import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { refAdvanced } from "@plugins/infra/plugins/git/plugins/git-watcher/server";
import { watchConfig } from "@plugins/config_v2/server";
import { compositionsConfig } from "@plugins/plugin-meta/plugins/composition/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { handleBuild } from "./internal/handle-build";
import { handleServeComposition } from "./internal/handle-serve-composition";
import { buildJob } from "./internal/run-build";
import { buildRunJob } from "./internal/build-run-job";
import { buildRunDebouncedJob } from "./internal/build-run-debounced-job";
import { compositionTickJob } from "./internal/composition-tick-job";
import { reconcileDeployment } from "./internal/reconcile";
import { buildRunTerminalWatcher } from "./internal/run-terminal";
import {
  triggerBuildEndpoint,
  serveCompositionEndpoint,
} from "../core/endpoints";

export { onRunTerminal } from "./internal/run-terminal";

export default {
  description:
    "Build, desktop-only half: runs `./singularity build` as a supervised job — the Build and Serve routes, the auto-build convergence loop (the refs/heads/main trigger, the debounce, the composition tick, the config watch and the boot reconcile) and the run-terminal watcher.",
  contributions: [
    Trigger({
      on: refAdvanced.where({ refName: "refs/heads/main" }),
      do: buildRunJob,
      with: {},
      oneShot: false,
    }),
  ],
  httpRoutes: {
    [triggerBuildEndpoint.route]: handleBuild,
    [serveCompositionEndpoint.route]: handleServeComposition,
  },
  // `buildJob` is ONE token that mounts BOTH halves — the queue job and its
  // supervised-run kind — and both must be registered: the primitive's own
  // `onReady` reconciler loops the registered set of kinds, so a kind that never
  // lands here would start runs nothing ever closes.
  register: [
    buildRunJob,
    buildRunDebouncedJob,
    compositionTickJob,
    buildJob,
    buildRunTerminalWatcher,
  ],
  onReady: async () => {
    // Unfinished `build_runs` rows are no longer reconciled here, and neither is
    // the boot re-adoption of a build that outlived the backend it restarted:
    // both are the supervised-run primitive's ONE reconciler, which closes a
    // build whose process is gone and re-attaches — transcript still streaming —
    // to one that is not. `reconcileOrphanBuilds` and `watchInflightBuild` were
    // two near-copies of that, and are deleted.
    //
    // The "observer starts" edge. It exists because the other two edges both run
    // in a process a build can kill: if a push lands while a build is finishing,
    // the reconcile that would have caught it can die with the backend. This one
    // asks the same question from durable state after the restart, so the answer
    // survives. In the 2026-08-19 incident this edge alone would have caught it.
    //
    // Both the main-only scope and the autoBuild kill switch live inside
    // reconcileDeployment, so every edge is gated identically by construction.
    await reconcileDeployment();

    // The "what should be served changed" edge. Switching a composition to `push`
    // should act at once rather than at the next quarter-hour tick, and this is
    // the only signal that says so — the tree has not moved, so no ref advances.
    //
    // watchConfig fires immediately on registration too, which is a second
    // `onReady` reconcile; harmless, because the debounce coalesces it with the
    // one above and with the burst a Studio edit produces. And an extra edge can
    // never cause a wrong build: `decideBuilds` re-derives the whole decision
    // from durable state, so an edge only ever asks the question again.
    watchConfig(compositionsConfig, () => {
      // Detached on purpose: a config subscriber is synchronous, so there is no
      // caller to await this. Through `runTracked` so the reconcile's cost lands
      // on a span of its own instead of inflating whichever span happened to be
      // open when the config write landed.
      void runTracked("build:reconcile-on-config", () => reconcileDeployment());
    });
  },
} satisfies MachinePluginDefinition;
