import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/plugins/action-bar/web";
import { TasksButton } from "./components/tasks-button";

export default {
  description:
    "Toolbar button that toggles the task pane (tree + detail) for the conversation's task.",
  contributions: [
    Conversation.ActionBar({
      id: "tasks",
      requires: [],
      component: TasksButton,
    }),
  ],
} satisfies PluginDefinition;
