import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { investigateReport } from "@plugins/reports/core";
import { handleInvestigate } from "./internal/handle-investigate";

export default {
  description:
    "The reports engine, desktop-only half: POST /api/reports/:id/investigate — files (or reuses) a report's investigation task for an agent to run on the computer (needsMachine, so a host without it answers unavailable).",
  httpRoutes: {
    [investigateReport.route]: handleInvestigate,
  },
} satisfies MachinePluginDefinition;
