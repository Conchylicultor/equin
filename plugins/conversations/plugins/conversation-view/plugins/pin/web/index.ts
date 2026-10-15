import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { PinButton } from "./components/pin-button";

export default {
  description:
    "Pin / unpin button beside the conversation title in the pane header — the same queue pin as the sidebar Queue row's, lifting the conversation's task group into the Pinned section.",
  contributions: [
    conversationPane.Actions({ id: "pin", component: PinButton }),
  ],
} satisfies PluginDefinition;
