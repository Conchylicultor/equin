import { useMemo } from "react";
import { mapRow, useLive } from "@plugins/network/plugins/live/web";
import type { ResourceResult } from "@plugins/network/plugins/live/plugins/live-state/web";
import type { TaskCategoryDef } from "@plugins/tasks/plugins/task-category/core";
import { taskCategories, taskCategoryRegistry } from "../shared/resources";

/**
 * The registered categories: a read — loading, failed, or the list. Fixed for
 * the server process (each filing plugin contributes its own at load time),
 * hydrated at boot and never garbage-collected (`boot-and-keep`). Ordered
 * server-side by `order ?? 0` then id. Not known yet is the loading arm, never
 * an empty registry.
 */
export function useTaskCategories(): ResourceResult<TaskCategoryDef[]> {
  return useLive(taskCategoryRegistry);
}

/**
 * One task's category id: a read — loading, failed, or the id (`null` when the
 * task has none, the "None" bucket). Its row of the lookup-only
 * `task-categories.by-id`; not loaded yet is the loading arm, never `null`
 * (which would claim the task uncategorized).
 */
export function useTaskCategory(taskId: string): ResourceResult<string | null> {
  const result = useLive(taskCategories, { id: taskId });
  return useMemo(
    () => mapRow(result, (row) => (row ? row.category : null)),
    [result],
  );
}
