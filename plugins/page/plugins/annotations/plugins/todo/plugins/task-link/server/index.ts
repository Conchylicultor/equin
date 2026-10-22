import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { todoTasksServed } from "./internal/resource";
import { resolveTodoAnnotations } from "./internal/annotations";
import { handleCreateTodoBlockTask } from "./internal/routes";
import { createTodoBlockTask } from "../shared/endpoints";

export { _pageBlocksTodoTaskExt, todoTask } from "./internal/tables";
export { ensureTodoTask } from "./internal/mutations";
export { todoTasksServed } from "./internal/resource";

export default {
  portable: true,
  description:
    "Owns page_blocks_ext_todo_task: the ONE task a TODO card dispatches agents onto. The block-keyed link table (its primary key IS the one-task-per-card rule), the per-card live read, the idempotent dispatch endpoint that composes the agent's prompt, and the markdown provider that emits the card's task_id/status to read_page.",
  contributions: [
    ...todoTasksServed.declare,
    Editor.BlockAnnotation({ resolve: resolveTodoAnnotations }),
  ],
  httpRoutes: {
    [createTodoBlockTask.route]: handleCreateTodoBlockTask,
  },
} satisfies ServerPluginDefinition;
