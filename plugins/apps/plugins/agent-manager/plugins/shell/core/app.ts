import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

export const agentManagerApp = defineApp({
  id: "agent-manager",
  name: "Agent Manager",
  basePath: "/agents",
  icon: symbol("chat-bubble"),
});
