import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/plugins/action-bar/web";
import { CommitsChip } from "./components/commits-chip";
import { convCommitsGraphPane } from "./panes";

export default {
  description:
    "Toolbar chip showing commits ahead/behind main; opens a side pane with the chain of commits between merge-base and HEAD.",
  contributions: [
    Pane.Register({ pane: convCommitsGraphPane }),
    Conversation.ActionBar({
      id: "commits-graph",
      requires: ["git"],
      component: CommitsChip,
    }),
  ],
  slots: { "conv-commits-graph": convCommitsGraphPane },
} satisfies PluginDefinition;
