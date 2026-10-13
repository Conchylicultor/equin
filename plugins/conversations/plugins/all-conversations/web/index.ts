import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { Shell } from "@plugins/shell/web";
import { opensPane } from "@plugins/primitives/plugins/app-shell/web";
import { allConversationsPane } from "./panes";
import { symbol } from "@plugins/ui/plugins/icons/core";

export { allConversationsPane } from "./panes";
export { useConversationFieldDefs } from "./internal/fields";

export default {
  description:
    "All-conversations app pane: a live DataView over the `conversations.all` collection (filter/sort/search over every conversation, kept fresh by the routed change feed) reachable from the agent-manager sidebar.",
  contributions: [
    Pane.Register({ pane: allConversationsPane }),
    Shell.Sidebar({
      id: "all-conversations",
      title: "Conversations",
      icon: symbol("chat-bubble"),
      opens: opensPane(allConversationsPane, {}),
    }),
  ],
  slots: {
    "all-conversations": allConversationsPane,
  },
} satisfies PluginDefinition;
