import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { interactionBudgetKind } from "./internal/kind";

export default {
  description:
    "Interaction-budget report kind: one row per scenario (fingerprint = scenario id) whose measured work — a count such as elements restyled, not a time — went over its budget on main's deploy, filed through the report outbox by the scenario's budget run. Renders a task naming the commit range since the last run within budget, every case's median against its budget, and the command that reproduces it. Warning, re-arms every 6 h.",
  contributions: [interactionBudgetKind],
} satisfies ServerPluginDefinition;
