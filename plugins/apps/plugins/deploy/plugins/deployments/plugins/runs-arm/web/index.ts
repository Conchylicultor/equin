import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { investigateRuns, runLinks } from "@plugins/runs/web";
import { DEPLOY_CATEGORY_ID } from "@plugins/apps/plugins/deploy/core";
import { DEPLOY_LOG_CHANNEL } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { deployRunArm } from "../core";
import { deployRunLink } from "./internal/deploy-run-link";
import { deployRunPresentation } from "./internal/presentation";

export default {
  description:
    "The deploy arm's presence on the merged run surface: its rows' link into the deployment detail pane on the server the run went to, and the cells of its eight own fields (verb, failed phase, server / deployment / composition / release-run / commit ids, exit code) — real filterable and sortable SQL dimensions, declared by the arm.",
  contributions: [
    runLinks(deployRunArm, (run, { openPane }) => deployRunLink(run, openPane)),
    // Its fields' cells; the fields — under their "Deploy" band — are the
    // arm's (`deployRunArm`, core).
    deployRunPresentation,
    // A failed deploy's Investigate action, in every list of runs.
    investigateRuns(deployRunArm, {
      noun: "deploy",
      categoryId: DEPLOY_CATEGORY_ID,
      whereToDig: (run) => [
        `the whole transcript is in the \`${DEPLOY_LOG_CHANNEL}\` log channel; each run is prefixed by its own argv line, so find this run's spawn and read forward from it;`,
        `the ledger row: \`select * from deploy_runs where id = '${run.id}'\` via \`query_db\`;`,
        "`./singularity deploy` is the engine — every refusal, host mutation and health gate is the CLI's, so a wrong verdict is a CLI or host-state bug, not a UI one. Do not touch a remote host without being asked.",
      ],
    }),
  ],
} satisfies PluginDefinition;
