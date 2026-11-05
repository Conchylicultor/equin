import { z } from "zod";
import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
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

// The category of a task, by id (`useLive(taskCategories, { id: taskId })`;
// `found: false` is "no category"). Lookup-only (`:rows` alone, never
// preloaded): the one reader asks about ONE task (the task detail's
// dependency card files a prerequisite under its task's category), and a LIST
// of tasks reads the category exposed into its rows (`exposes` above) — so the
// set is bounded by construction, its cost one row per mounted reader. Served
// from the extension table (`server/internal/resource.ts`): a category write
// reaches only the tuples naming that task.
//
// The key is `task-categories.by-id`, not the old whole set's
// `task-categories`: a tab on an older bundle subscribing `{}` gets
// `unknown-key` (a `skew` verdict), never these rows.
export const taskCategories = liveCollection("task-categories.by-id", {
  from: taskCategoryShape,
  id: "taskId",
});

// The registered categories (every filing plugin's `TaskCategory`
// contribution), ordered by `order ?? 0` then id. Fixed for the life of the
// server process, so served `fixed` (`server/internal/registry.ts`).
// `boot-and-keep`: hydrated before first paint — it is the exposed `category`
// field's options (its sections' labels and order), loading until known, so a
// category-grouped task list would otherwise wait a round trip — and never
// garbage-collected, since every task-list surface reads it.
export const taskCategoryRegistry = liveValue("task-category.registry", {
  schema: wholeList(TaskCategoryDefSchema, {
    reason:
      "one entry per registered task category — declared in code, a few dozen",
  }),
  preload: "boot-and-keep",
});
