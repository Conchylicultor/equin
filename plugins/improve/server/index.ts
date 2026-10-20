import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { TaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { conversationCreated } from "@plugins/tasks/plugins/tasks-core/server";
import { IMPROVEMENTS_CATEGORY_ID } from "../core/task-category";
import { applyGroupJob } from "./internal/apply-group-job";

export { _improvePendingGroups } from "./internal/tables";

export default {
  description:
    'Toolbar button and category for app-improvement feedback. Files tasks stamped "Improvements" via the shared task-draft-form primitive.',
  register: [applyGroupJob],
  contributions: [
    Trigger({
      on: conversationCreated,
      do: applyGroupJob,
      with: {},
      oneShot: false,
    }),
    TaskCategory({
      id: IMPROVEMENTS_CATEGORY_ID,
      label: "Improvements",
      order: 3,
    }),
  ],
} satisfies ServerPluginDefinition;
