import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { Item } from "@plugins/conversations/plugins/conversation-ui/plugins/item/web";
import { ProgressBarToolbar } from "./components/progress-bar-toolbar";
import { ProgressBarRow } from "./components/progress-bar-row";

export default {
  description:
    "4-step progress bar (started → designed → implemented → pushed) in the conversation toolbar and sidebar chip.",
  contributions: [
    conversationPane.Actions({ id: "progress", component: ProgressBarToolbar }),
    Item.Chips({ id: "progress", component: ProgressBarRow }),
  ],
} satisfies PluginDefinition;
