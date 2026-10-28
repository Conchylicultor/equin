import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ExitMenu } from "@plugins/conversations/plugins/conversation-view/plugins/exit-menu/web";
import { DropAndExitItem } from "./components/drop-and-exit-button";

export { droppedNotification } from "./internal/dropped-notification";

export default {
  description:
    "Exit-menu entry that marks the top task as dropped and closes the conversation; droppedNotification, the Conversation dropped notification every drop surface sends.",
  contributions: [ExitMenu.Item({ id: "drop-and-exit", component: DropAndExitItem })],
} satisfies PluginDefinition;
