import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { TaskCategory } from "@plugins/tasks/plugins/task-category/server";
import {
  CONVERSATIONS_CATEGORY_ID,
  SYSTEM_CATEGORY_ID,
} from "@plugins/conversations/core";

export default {
  portable: true,
  description:
    "The task categories a conversation's own task is filed under (Conversations, System), registered from a portable barrel so every host labels them — the browser host included, which does not boot the conversations server barrel that files them.",
  contributions: [
    TaskCategory({
      id: CONVERSATIONS_CATEGORY_ID,
      label: "Conversations",
      order: 0,
    }),
    TaskCategory({ id: SYSTEM_CATEGORY_ID, label: "System", order: 1 }),
  ],
} satisfies ServerPluginDefinition;
