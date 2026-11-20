import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { RenameConversationAction } from "./components/rename-action";

export default {
  description:
    "Rename a conversation by hand: RenameConversationAction, the item action a conversation list contributes to its rows (the sidebar's Queue and History, in the row's ⋯ menu), opening a dialog that writes the conversation's own title as the user's.",
} satisfies PluginDefinition;
