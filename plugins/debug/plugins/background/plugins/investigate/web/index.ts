import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { RecentRunActions } from "@plugins/infra/plugins/background/plugins/catalog/web";
import { InvestigateRun } from "./components/investigate-run";

export default {
  description:
    "The Investigate action on every failed run in a background entry's Recent runs: launches an agent briefed on the run (its error verbatim, the entry's description, declaring plugin and facts, and where to dig), filed under the Background category and about that run, so the row turns into View task.",
  contributions: [
    RecentRunActions({ id: "investigate", component: InvestigateRun }),
  ],
} satisfies PluginDefinition;
