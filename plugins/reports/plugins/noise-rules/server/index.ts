import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportNoiseRule } from "@plugins/reports/server";
import { staleFrontendRule } from "./internal/rules";

export default {
  description:
    "Built-in noise classification rules: each judges a proven fact about a report (a tab failing to load a file of its own build that the server retired — the tab named the 404 file, the server confirmed the build retired), never its message text nor a guess.",
  contributions: [ReportNoiseRule(staleFrontendRule)],
} satisfies ServerPluginDefinition;
