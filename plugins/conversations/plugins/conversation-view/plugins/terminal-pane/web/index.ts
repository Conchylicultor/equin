import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/plugins/action-bar/web";
import { JsonlViewer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { TerminalButton } from "./components/terminal-button";
import { OpenTerminalButton } from "./components/open-terminal-button";
import { convTerminalPane } from "./panes";

export default {
  description:
    "Toolbar button that opens a right pane attaching to the conversation's tmux session.",
  contributions: [
    Pane.Register({ pane: convTerminalPane }),
    Conversation.ActionBar({
      id: "terminal",
      requires: [],
      component: TerminalButton,
    }),
    JsonlViewer.PendingPromptAction({
      id: "open-terminal",
      component: OpenTerminalButton,
    }),
  ],
  slots: { "conv-terminal": convTerminalPane },
} satisfies PluginDefinition;
