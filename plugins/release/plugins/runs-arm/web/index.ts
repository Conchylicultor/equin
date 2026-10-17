import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { investigateRuns, runLinks } from "@plugins/runs/web";
import {
  RELEASE_CATEGORY_ID,
  RELEASE_LOG_CHANNEL,
} from "@plugins/release/core";
import { releaseDetailPane } from "@plugins/apps/plugins/studio/plugins/compositions/plugins/release/web";
import { releaseRunArm } from "../core";
import { releaseRunPresentation } from "./internal/presentation";

export default {
  description:
    "The release arm's presence on the merged run surface: its rows' link into the Studio release run-detail pane, plus the composition / target / platform / provenance columns only a release row has.",
  contributions: [
    // The run-detail pane is keyed by run id alone — which is exactly what the
    // ledger row carries — so a release row activates from the merged list the
    // same way it does from a composition's release history.
    runLinks(releaseRunArm, (run, { openPane }) =>
      openPane.to(releaseDetailPane, { runId: run.id }, { mode: "push" }),
    ),
    // Its fields' cells; the fields — under their "Release" band — are the
    // arm's (`releaseRunArm`, core).
    releaseRunPresentation,
    // A failed release's Investigate action, in every list of runs.
    investigateRuns(releaseRunArm, {
      noun: "release",
      categoryId: RELEASE_CATEGORY_ID,
      whereToDig: (run) => [
        `the release transcript: the \`${RELEASE_LOG_CHANNEL}\` log channel, and the Studio release run-detail pane (this run), which shows its output;`,
        `the ledger row: \`select * from release_runs where id = '${run.id}'\` via \`query_db\`;`,
        "`./singularity release` is the engine — a failed bundle is the CLI's verdict, so a wrong one is a CLI or code bug, not a UI one.",
      ],
    }),
  ],
} satisfies PluginDefinition;
