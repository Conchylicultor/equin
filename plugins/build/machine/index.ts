import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { watchConfig } from "@plugins/config_v2/server";
import { compositionsConfig } from "@plugins/plugin-meta/plugins/composition/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { handleBuild } from "./internal/handle-build";
import { handleServeComposition } from "./internal/handle-serve-composition";
import { buildJob } from "./internal/run-build";
import { compositionTickJob } from "./internal/composition-tick-job";
import { requestConvergence } from "./internal/request-convergence";
import {
  onAutoBuildTerminal,
  recentClosedAutoBuilds,
} from "./internal/run-state";
import {
  buildRunTerminalWatcher,
  onRunTerminal,
} from "./internal/run-terminal";
import {
  triggerBuildEndpoint,
  serveCompositionEndpoint,
} from "../core/endpoints";

export { onRunTerminal } from "./internal/run-terminal";

export default {
  description:
    "Build, desktop-only half: runs `./equin build` as a supervised job (the Build and Serve routes), the run-terminal watcher, and the backend's side of main's auto-build — which the gateway runs (`./equin build --allow-main --converge`, build/converge), not this backend: the bell for the builds it ran, and the two optional edges only a backend sees (the compositions config changing, the composition cadence tick).",
  httpRoutes: {
    [triggerBuildEndpoint.route]: handleBuild,
    [serveCompositionEndpoint.route]: handleServeComposition,
  },
  // `buildJob` is ONE token that mounts BOTH halves — the queue job and its
  // supervised-run kind — and both must be registered: the primitive's own
  // `onReady` reconciler loops the registered set of kinds, so a kind that never
  // lands here would start runs nothing ever closes.
  register: [compositionTickJob, buildJob, buildRunTerminalWatcher],
  onReady: async () => {
    // Main's auto-build is no longer decided or run here. Every edge of the old
    // loop lived in this backend (the refs/heads/main trigger, the debounce, the
    // boot and terminal reconciles), so a main that could not serve could not
    // deploy the commit that fixed it (2026-11-08). The gateway now starts the
    // convergence run on every advance of main and on its own boot; see
    // `build/converge` and gateway/CLAUDE.md.
    //
    // What stays here is what only a backend can do or see.
    //
    // The bell for a build the convergence run started: no workflow of this
    // backend owns it, so its exit marker is the edge — and this boot, for
    // those that ended while main had no backend.
    await onRunTerminal((runId) => {
      void runTracked("build:auto-bell", () => onAutoBuildTerminal(runId));
    });
    for (const runId of await recentClosedAutoBuilds())
      await onAutoBuildTerminal(runId);

    // The "what should be served changed" edge: switching a composition to
    // `push` acts at once rather than at the next tick. watchConfig also calls
    // back once on registration with the current value, which is not a change —
    // skipped, or every boot of main (every deploy) would start a run. Detached:
    // a config subscriber is synchronous.
    let registered = false;
    watchConfig(compositionsConfig, () => {
      if (!registered) {
        registered = true;
        return;
      }
      void runTracked("build:converge-on-config", () =>
        requestConvergence("compositions config changed"),
      );
    });
  },
} satisfies MachinePluginDefinition;
