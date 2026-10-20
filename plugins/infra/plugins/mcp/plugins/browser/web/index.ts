import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { HealthReport } from "@plugins/shell/plugins/health-report/web";
import { AgentBrowserDetail } from "./components/agent-browser-detail";
import { useAgentBrowserHealth } from "./internal/use-agent-browser";

export default {
  description:
    "The health report's Agent browser row: whether the machine's agent-browser host runs, its sessions (what each is for — its task's title — its tab count, and how long until it closes if left idle), a recent failure the host hit on its own, and a host that died without closing them — read from the agent-browser.status push value.",
  contributions: [
    HealthReport.Row({
      kind: "status",
      id: "agent-browser",
      title: "Agent browser",
      // After the rows that say whether the app works at all (Claude Code 5,
      // Connection 10, Database 20, Machine watcher 30): a tool agents use,
      // not the app itself.
      order: 40,
      useStatus: useAgentBrowserHealth,
      component: AgentBrowserDetail,
    }),
  ],
} satisfies PluginDefinition;
