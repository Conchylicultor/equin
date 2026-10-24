import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { MenuBar } from "@plugins/menu-bar/web";
import { useAgentsStatus } from "./use-agents-status";

export default {
  description:
    "The agents' part of the menu-bar panel's status line (MenuBar.Status 'agents'): from useConversations(), partitioned like the agent manager's home — working or starting → 'N agents working', waiting → 'N need you' — with attention while any agent waits on the user, which lights the menu-bar icon's dot.",
  contributions: [
    MenuBar.Status({
      id: "agents",
      label: "Agents",
      useStatus: useAgentsStatus,
    }),
  ],
} satisfies PluginDefinition;
