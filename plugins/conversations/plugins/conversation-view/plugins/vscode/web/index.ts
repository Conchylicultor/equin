import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/plugins/action-bar/web";
import { VscodeButton } from "./components/vscode-button";

export default {
  description: "Opens the conversation's worktree in VSCode.",
  contributions: [
    Conversation.ActionBar({
      id: "vscode",
      requires: [],
      component: VscodeButton,
    }),
  ],
} satisfies PluginDefinition;
