import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { attachmentRenderer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web";
import { TaskReminderAttachmentView } from "./components/task-reminder-attachment-view";

export default {
  collapsed: true,
  description:
    "Renders task-reminder attachment events showing periodic task list injections.",
  contributions: [
    ...attachmentRenderer({
      match: "task_reminder",
      component: TaskReminderAttachmentView,
      role: "conversation",
    }),
  ],
} satisfies PluginDefinition;
