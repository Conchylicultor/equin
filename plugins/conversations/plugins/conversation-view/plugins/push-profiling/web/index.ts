import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/plugins/action-bar/web";
import { PushProfilingButton } from "./components/push-profiling-button";
import { convPushProfilingPane } from "./panes";

export default {
  description:
    "Toolbar button showing the op Gantt scoped to the conversation's worktree.",
  contributions: [
    Pane.Register({ pane: convPushProfilingPane }),
    Conversation.ActionBar({
      id: "push-profiling",
      requires: ["build"],
      component: PushProfilingButton,
    }),
  ],
  slots: { "conv-push-profiling": convPushProfilingPane },
} satisfies PluginDefinition;
