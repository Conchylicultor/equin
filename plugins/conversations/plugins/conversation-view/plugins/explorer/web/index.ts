import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/plugins/action-bar/web";
import { ConvTreeButton } from "./components/conv-tree-button";
import { OpenInFilesAction } from "./components/open-in-files-action";
import { convFileTreePane } from "./panes";

export default {
  description:
    "Conversation toolbar button opening a side pane that browses the agent's worktree with the file explorer's <FileBrowser/> (wearing the Files theme), rooted at the checkout, its folder and open file carried in the pane's route (;dir / ;open), with Open in Files at that location (git status from the file explorer's git lens).",
  contributions: [
    Pane.Register({ pane: convFileTreePane }),
    convFileTreePane.Actions({
      id: "open-in-files",
      component: OpenInFilesAction,
    }),
    Conversation.ActionBar({
      id: "explorer",
      requires: ["git"],
      component: ConvTreeButton,
    }),
  ],
  slots: { "conv-file-tree": convFileTreePane },
} satisfies PluginDefinition;
