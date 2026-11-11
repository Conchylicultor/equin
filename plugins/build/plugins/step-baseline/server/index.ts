import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { stepRegressionKind } from "./internal/kind";

export default {
  description:
    "Build-step-regression report kind: one row per step and metric (time, or file calls in a build that rebuilt nothing), filed through the report outbox by main's `./equin build` when a step jumps against its own recent baseline in two same-work builds in a row. Renders a task naming the step, the before/after and, for file calls, the path prefixes the extra calls went to. Warning, re-arms every 6 h.",
  contributions: [stepRegressionKind],
} satisfies ServerPluginDefinition;
