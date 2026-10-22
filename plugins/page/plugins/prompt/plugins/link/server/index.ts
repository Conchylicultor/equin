import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { TaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { promptBlockTasksServed } from "./internal/resource";
import { handleCreatePromptBlockTask } from "./internal/routes";
import { PAGES_CATEGORY_ID } from "./internal/mutations";
import { createPromptBlockTask } from "../shared/endpoints";

export { promptBlock } from "./internal/tables";
export {
  PAGES_CATEGORY_ID,
  createTaskFromPromptBlock,
  getPromptTaskOrigin,
} from "./internal/mutations";

export default {
  portable: true,
  description:
    "Owns the tasks_ext_prompt_block side-table: the page/block a task was launched from, the live link collection over it (block-side window, task-side row lookup), the create-task endpoint, and the Pages task category.",
  contributions: [
    ...promptBlockTasksServed.declare,
    TaskCategory({ id: PAGES_CATEGORY_ID, label: "Pages", order: 5 }),
  ],
  httpRoutes: {
    [createPromptBlockTask.route]: handleCreatePromptBlockTask,
  },
} satisfies ServerPluginDefinition;
