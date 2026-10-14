import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Runs } from "@plugins/runs/web";
import { buildDetailPane } from "@plugins/build/web";
import { BUILD_RUN_KIND } from "@plugins/build/plugins/run-ledger/core";
import { buildRunArm } from "../core";
import { BuildRunLeading } from "./components/build-run-leading";
import { buildRunPresentation } from "./internal/presentation";

export default {
  description:
    "The build arm's presence on the merged run surface: the Build kind (whose rows open the existing build run-detail pane), the six-way build status dot as the list row's leading indicator, and the status / targets / commit / exit-code columns only a build row has.",
  contributions: [
    Runs.Kind({
      arm: buildRunArm,
      // The run-detail pane already exists and is already reached by run id
      // alone — the merged row carries everything it needs, so a build row
      // activates from the merged list exactly as it does from the build pane.
      link: (run, { openPane }) =>
        openPane.to(buildDetailPane, { runId: run.id }, { mode: "push" }),
    }),
    Runs.Leading({ match: BUILD_RUN_KIND, component: BuildRunLeading }),
    // Its fields' cells; the fields themselves — and their "Build" band in
    // every field list — are the arm's (`buildRunArm`, core).
    buildRunPresentation,
  ],
} satisfies PluginDefinition;
