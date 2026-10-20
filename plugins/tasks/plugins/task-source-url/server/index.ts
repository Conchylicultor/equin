import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { attemptSourceUrlServed } from "./internal/resource";

export { tasksSourceUrl } from "./internal/tables";
export { setTaskSourceUrl } from "./internal/mutations";

export default {
  portable: true,
  description:
    "Owns the tasks_ext_source_url side-table: the page a task was filed from (the draft form's Page URL toggle), stored as data rather than only as prompt text, and read back by attempt (falling back to the url of the first <ui-context> in the task's prompt).",
  contributions: [...attemptSourceUrlServed.declare],
} satisfies ServerPluginDefinition;
