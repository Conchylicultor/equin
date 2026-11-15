import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  attemptSourceUrlServed,
  taskSourceUrlsServed,
} from "./internal/resource";
import { sourcePageSection } from "./internal/system-prompt";

export { tasksSourceUrl } from "./internal/tables";
export { setTaskSourceUrl } from "./internal/mutations";

export default {
  description:
    "Owns the tasks_ext_source_url side-table: the page a task was filed from (the draft form's Page URL toggle), stored as data rather than as prompt text: handed to the task's agents as the `source-page` system-prompt section at every spawn, and read back by attempt (falling back to the url of the first <ui-context> in the task's prompt).",
  contributions: [
    ...attemptSourceUrlServed.declare,
    ...taskSourceUrlsServed.declare,
    sourcePageSection,
  ],
} satisfies ServerPluginDefinition;
