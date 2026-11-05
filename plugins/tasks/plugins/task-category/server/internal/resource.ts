import { serveCollection } from "@plugins/network/plugins/live/server";
import { taskCategories } from "../../shared/resources";
import { taskCategoriesServeOptions } from "./serve-options";

// The `:rows` point resource, routed over `tasks_ext_category`: a category
// set, change or clear (or the task's delete, by FK cascade) reaches only the
// tuples naming that task, as that one row.
export const taskCategoriesServed = serveCollection(
  taskCategories,
  taskCategoriesServeOptions,
);
