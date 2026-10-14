import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/plugins/action-bar/web";
import { EventCounter } from "./components/event-counter";

export default {
  description: "Displays the total event count in the conversation toolbar.",
  contributions: [
    Conversation.ActionBar({
      id: "event-counter",
      requires: [],
      component: EventCounter,
    }),
  ],
} satisfies PluginDefinition;
