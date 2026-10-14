import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/plugins/action-bar/web";
import { ConvTreeButton } from "./components/conv-tree-button";
import { convFileTreePane } from "./panes";

export default {
  description:
    "Conversation toolbar button opening a side pane that browses the agent's worktree with the file explorer's <FileBrowser/>, rooted at the checkout (git status from the file explorer's git lens).",
  contributions: [
    Pane.Register({ pane: convFileTreePane }),
    Conversation.ActionBar({
      id: "explorer",
      requires: ["git"],
      component: ConvTreeButton,
    }),
  ],
  slots: { "conv-file-tree": convFileTreePane },
} satisfies PluginDefinition;
