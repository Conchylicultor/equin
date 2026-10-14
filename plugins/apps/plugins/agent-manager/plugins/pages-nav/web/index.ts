import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/plugins/action-bar/web";
import { PagesTreeButton } from "./components/pages-tree-button";

export default {
  description:
    "Pages entry point in the agent manager: a conversation-toolbar toggle that opens the Pages tree as a column beside the conversation.",
  contributions: [
    Conversation.ActionBar({
      id: "pages",
      requires: [],
      component: PagesTreeButton,
    }),
  ],
} satisfies PluginDefinition;
