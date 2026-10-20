import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { AllowMonitorChip } from "./components/allow-monitor-chip";

export default {
  description:
    "Flags when an agent has created a guard-bypass file (.allow-main, .allow-postgres, …) in its worktree.",
  contributions: [
    conversationPane.Actions({
      id: "allow-monitor",
      component: AllowMonitorChip,
    }),
  ],
} satisfies PluginDefinition;
