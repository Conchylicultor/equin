import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { HealthReport } from "@plugins/shell/plugins/health-report/web";
import { InvestigateMcpButton } from "./components/investigate-mcp-button";
import { useMcpHealth } from "./internal/use-mcp-health";

export default {
  description:
    "The health report's MCP server row: critical while the latest MCP request failed (agents launched from here have no equin tools), attention while a per-connection contribution (a tool's gate or live description, an instructions section) keeps throwing, read from the mcp.health push value — with an Investigate remedy launching an agent briefed with what failed.",
  contributions: [
    HealthReport.Row({
      kind: "status",
      id: "mcp-server",
      title: "MCP server",
      useStatus: useMcpHealth,
      // Drawn only while failing or degraded, so the row still folds while fine.
      remedy: InvestigateMcpButton,
    }),
  ],
} satisfies PluginDefinition;
