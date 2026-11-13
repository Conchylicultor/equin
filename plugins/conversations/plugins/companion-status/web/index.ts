import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Companion } from "@plugins/companions/plugins/panel/web";
import { useAgentsStatus } from "./use-agents-status";

export default {
  description:
    "The agents' part of every companion's status line (Companion.Status 'agents' — the menu-bar tray's header, later the browser extension's): from useConversations(), partitioned like the agent manager's home — working or starting → 'N agents working', waiting → 'N need you' — with attention while any agent waits on the user, which the companion shows as its attention (the menu-bar icon's dot).",
  contributions: [
    Companion.Status({
      id: "agents",
      label: "Agents",
      useStatus: useAgentsStatus,
    }),
  ],
} satisfies PluginDefinition;
