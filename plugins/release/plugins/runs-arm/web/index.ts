import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Runs } from "@plugins/runs/web";
import { releaseDetailPane } from "@plugins/apps/plugins/studio/plugins/compositions/plugins/release/web";
import { releaseRunArm } from "../core";
import { releaseRunPresentation } from "./internal/presentation";

export default {
  description:
    "The release arm's presence on the merged run surface: the Release kind (whose rows open the Studio release run-detail pane), plus the composition / target / platform / provenance columns only a release row has.",
  contributions: [
    Runs.Kind({
      arm: releaseRunArm,
      // The run-detail pane is keyed by run id alone — which is exactly what the
      // ledger row carries — so a release row activates from the merged list the
      // same way it does from a composition's release history.
      link: (run, { openPane }) =>
        openPane.to(releaseDetailPane, { runId: run.id }, { mode: "push" }),
    }),
    // Its fields' cells; the fields — under their "Release" band — are the
    // arm's (`releaseRunArm`, core).
    releaseRunPresentation,
  ],
} satisfies PluginDefinition;
