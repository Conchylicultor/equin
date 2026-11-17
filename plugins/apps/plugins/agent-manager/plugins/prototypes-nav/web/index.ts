import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/plugins/action-bar/web";
import { PrototypesGalleryButton } from "./components/prototypes-gallery-button";

export default {
  description:
    "Prototypes entry point in the agent manager: a conversation-toolbar button that toggles the Prototypes gallery as a column beside the conversation (⌘/middle-click for a new browser tab).",
  contributions: [
    Conversation.ActionBar({
      id: "prototypes",
      requires: [],
      component: PrototypesGalleryButton,
    }),
  ],
} satisfies PluginDefinition;
