import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { TaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { conversationCreated } from "@plugins/tasks/plugins/tasks-core/server";
import { WISHES_CATEGORY_ID } from "../core";
import { applyGroupJob } from "./internal/apply-group-job";

export { _improvePendingGroups } from "./internal/tables";

export default {
  portable: true,
  description:
    'Task category of the Wish toolbar button. Files tasks stamped "Wishes" via the shared task-draft-form primitive.',
  register: [applyGroupJob],
  contributions: [
    Trigger({
      on: conversationCreated,
      do: applyGroupJob,
      with: {},
      oneShot: false,
    }),
    TaskCategory({
      id: WISHES_CATEGORY_ID,
      label: "Wishes",
      order: 3,
    }),
  ],
} satisfies ServerPluginDefinition;
