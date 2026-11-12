import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportNoiseRule } from "@plugins/reports/server";
import { staleFrontendRule } from "./internal/rules";

export default {
  description:
    "Built-in noise classification rules: each judges a fact about a report (a stale tab loading what the server no longer serves), never its message text.",
  contributions: [ReportNoiseRule(staleFrontendRule)],
} satisfies ServerPluginDefinition;
