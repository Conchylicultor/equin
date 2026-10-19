import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { HealthReport } from "@plugins/shell/plugins/health-report/web";
import { useCliDriftHealth } from "./internal/use-cli-drift";

export default {
  description:
    "The health report's Agent SDK row: attention when the system Claude Code the sdk runtime runs differs in major.minor from the CLI version the pinned Agent SDK was built for.",
  contributions: [
    HealthReport.Row({
      kind: "status",
      id: "agent-sdk-cli",
      title: "Agent SDK",
      // Right after Claude Code (5): it qualifies that row.
      order: 6,
      useStatus: useCliDriftHealth,
    }),
  ],
} satisfies PluginDefinition;
