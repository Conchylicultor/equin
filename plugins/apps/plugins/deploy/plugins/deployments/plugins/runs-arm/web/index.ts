import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Runs } from "@plugins/runs/web";
import { deployRunArm } from "../core";
import { deployRunLink } from "./internal/deploy-run-link";
import { deployRunPresentation } from "./internal/presentation";

export default {
  description:
    "The deploy arm's presence on the merged run surface: the Deploy kind (whose rows open the deployment detail pane on the server the run went to), and the cells of its eight own fields (verb, failed phase, server / deployment / composition / release-run / commit ids, exit code) — real filterable and sortable SQL dimensions, declared by the arm.",
  contributions: [
    Runs.Kind({
      arm: deployRunArm,
      link: (run, { openPane }) => deployRunLink(run, openPane),
    }),
    // Its fields' cells; the fields — under their "Deploy" band — are the
    // arm's (`deployRunArm`, core).
    deployRunPresentation,
  ],
} satisfies PluginDefinition;
