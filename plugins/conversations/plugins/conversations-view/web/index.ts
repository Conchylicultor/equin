import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Shell } from "@plugins/shell/web";
import { ConversationsSidebar } from "./components/conversations-sidebar";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description: "Sidebar list of all conversations.",
  contributions: [
    Shell.Sidebar({
      id: "conversations",
      title: "Conversations",
      icon: symbol("chat-bubble"),
      component: ConversationsSidebar,
      // This section fills the sidebar column and scrolls internally; keep that
      // bound in reorder edit mode so it doesn't overflow onto sibling sections.
      fill: true,
    }),
  ],
} satisfies PluginDefinition;
