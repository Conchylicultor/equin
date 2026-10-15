import { z } from "zod";
import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { tasksEntityRef } from "@plugins/tasks/plugins/tasks-core/core";
import { TaskCategoryDefSchema } from "../core";

// One row per categorized task, stored in the `tasks_ext_category`
// entity-extension table (1:1 per task), which `server/internal/tables.ts`
// builds from this shape. `category` is the contributed registry id
// (system-set only — no user picker).
//
// It EXPOSES the category to every list whose rows reach a task (`exposes` —
// the task list): a task with no row reads NULL (the field declares no
// default), the "None" bucket. Its options — the sections' labels and order —
// are the live registry's (`taskCategoryRegistry`, presented by this plugin's
// web half), never a static set. No list is named here.
export const taskCategoryShape = defineExtensionShape({
  key: "taskId",
  fields: { category: textField({ label: "Category" }) },
  exposes: {
    parent: tasksEntityRef,
    name: "category",
    fields: { category: {} },
  },
});
export const TaskCategoryRowSchema = taskCategoryShape.schema;
export type TaskCategoryRow = z.infer<typeof TaskCategoryRowSchema>;

// Every categorized task's category, as the WHOLE ordered set (`all`): a
// surface that needs any task's category (the task detail's dependency card,
// filing a prerequisite under it) holds the set entire. (A LIST of tasks reads neither: the
// category is exposed into its rows — `exposes` above.) Served from the extension
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
// Boot-critical (the task detail's dependency card files a prerequisite under
// its task's category): boot-snapshot hydrates the `{}` tuple before the first
// render, and the eager web tier is derived from this flag (this module sits in
// the eager web import graph via the plugin's web barrel).
export const taskCategories = liveCollection("task-categories", {
  from: taskCategoryShape,
  id: "taskId",
  all: {
    orderBy: [["taskId", "asc"]],
    unbounded: {
      reason:
        "at most one row per task, and the dependency card reads the category of any task it files under",
    },
  },
  preload: "boot",
});

// The registered categories (every filing plugin's `TaskCategory`
// contribution), ordered by `order ?? 0` then id. Fixed for the life of the
// server process, so served `fixed` (`server/internal/registry.ts`).
// `boot-and-keep`: hydrated before first paint — it is the exposed `category`
// field's options (its sections' labels and order), loading until known, so a
// category-grouped task list would otherwise wait a round trip — and never
// garbage-collected, since every task-list surface reads it.
export const taskCategoryRegistry = liveValue("task-category.registry", {
  schema: z.array(TaskCategoryDefSchema),
  preload: "boot-and-keep",
});
