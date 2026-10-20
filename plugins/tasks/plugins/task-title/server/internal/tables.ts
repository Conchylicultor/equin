import { _tasks } from "@plugins/tasks/plugins/tasks-core/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { taskShortTitleShape } from "../../core";

// Per-task short title, 1:1 with its task (FK cascade on task delete).
export const tasksShortTitle = defineExtension(
  _tasks,
  "short_title",
  taskShortTitleShape,
);
export const _tasksShortTitleExt = tasksShortTitle.table;
