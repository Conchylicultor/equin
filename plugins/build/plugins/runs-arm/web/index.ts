import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { investigateRuns, runLinks } from "@plugins/runs/web";
import { buildDetailPane } from "@plugins/build/web";
import { BUILD_CATEGORY_ID, BUILD_LOG_CHANNEL } from "@plugins/build/core";
import { buildRunArm } from "../core";
import { buildRunPresentation } from "./internal/presentation";

export default {
  description:
    "The build arm's presence on the merged run surface: its rows' link into the existing build run-detail pane, and the status / targets / commit / exit-code columns only a build row has.",
  contributions: [
    // The run-detail pane already exists and is already reached by run id
    // alone — the merged row carries everything it needs, so a build row
    // activates from the merged list exactly as it does from the build pane.
    runLinks(buildRunArm, (run, { openPane }) =>
      openPane.to(buildDetailPane, { runId: run.id }, { mode: "push" }),
    ),
    // Its fields' cells; the fields themselves — and their "Build" band in
    // every field list — are the arm's (`buildRunArm`, core).
    buildRunPresentation,
    // A failed build's Investigate action, in every list of runs.
    investigateRuns(buildRunArm, {
      noun: "build",
      categoryId: BUILD_CATEGORY_ID,
      whereToDig: (run) => [
        `the build transcript: the \`${BUILD_LOG_CHANNEL}\` log channel of namespace \`${run.namespace ?? "?"}\`, and the build detail pane (Build → this run), which shows each step's output;`,
        `the ledger row: \`select * from build_runs where id = '${run.id}'\` via \`query_db\` (pass the namespace's database);`,
        "`./equin build` is the engine — a failed step is the CLI's verdict, so a wrong one is a CLI or code bug, not a UI one.",
      ],
    }),
  ],
} satisfies PluginDefinition;
