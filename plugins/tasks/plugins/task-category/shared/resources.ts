import { z } from "zod";
import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { TaskCategoryDefSchema } from "../core";

// One row per categorized task, stored in the `tasks_ext_category`
// entity-extension table (1:1 per task), which `server/internal/tables.ts`
// builds from this shape. `category` is the contributed registry id
// (system-set only — no user picker).
export const taskCategoryShape = defineExtensionShape({
  key: "taskId",
  fields: { category: textField() },
});
export const TaskCategoryRowSchema = taskCategoryShape.schema;
export type TaskCategoryRow = z.infer<typeof TaskCategoryRowSchema>;

// Every categorized task's category, as the WHOLE ordered set (`all`): the
// task list's `category` field needs a value for every row the tasks DataView
// groups by, so its reader holds the set entire. Served from the extension
// table (`server/internal/resource.ts`): a category set is one entrant, a
// change one row's refill, a clear (or the task's delete, by FK cascade) an
// exit — never a whole-set reload.
//
// The wire row is EXACTLY the legacy `task-categories` row (`taskId`,
// `category`), under the same key: a tab still running a bundle that declared
// the old param-less descriptor subscribes `{}`, passes the `all` gate and
// parses these rows with its own (identical) schema — the C39 old-bundle check,
// pinned by `server/internal/task-categories-oracle.test.ts`. A change to the
// row must rename the key.
//
// Boot-critical so the default category-grouped tasks view never flashes
// "None" on first paint: boot-snapshot hydrates the `{}` tuple before the first
// render, and the eager web tier is derived from this flag (this module sits in
// the eager web import graph via the plugin's web barrel).
export const taskCategories = liveCollection("task-categories", {
  row: TaskCategoryRowSchema,
  id: "taskId",
  all: {
    orderBy: [["taskId", "asc"]],
    unbounded: {
      reason:
        "at most one row per task, and the task list groups every task by its category",
    },
  },
  preload: "boot",
});

// The registered categories (every filing plugin's `TaskCategory`
// contribution), ordered by `order ?? 0` then id. Fixed for the life of the
// server process, so served `fixed` (`server/internal/registry.ts`).
// `boot-and-keep`: hydrated before first paint — the category field is
// `pending` until both this and `taskCategories` are known, so a
// category-grouped tasks view would otherwise wait a round trip — and never
// garbage-collected, since every task-list surface reads it.
export const taskCategoryRegistry = liveValue("task-category.registry", {
  schema: z.array(TaskCategoryDefSchema),
  preload: "boot-and-keep",
});
