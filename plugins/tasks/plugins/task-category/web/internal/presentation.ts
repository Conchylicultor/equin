import { useMemo } from "react";
import {
  FieldPresentation,
  type LiveFieldOption,
  type LiveFieldOptionsRead,
} from "@plugins/network/plugins/live/web";
import { mapResource } from "@plugins/primitives/plugins/live-state/web";
import type { TaskCategoryDef } from "@plugins/tasks/plugins/task-category/core";
import { taskCategoryShape } from "../../shared/resources";
import { useTaskCategories } from "../hooks";

// Stable (module-level), so the mapped read changes only with the registry.
function toOptions(
  categories: readonly TaskCategoryDef[],
): readonly LiveFieldOption[] {
  return categories.map((c) => ({ value: c.id, label: c.label }));
}

/**
 * The `category` field's options: the LIVE registry, in its order (`order ??
 * 0`, then id) — a category-grouped list lays its sections out in it and names
 * them by its labels. Loading until the (boot-hydrated) registry is known:
 * never raw-id sections that relabel and reorder when it lands.
 */
export function useTaskCategoryOptions(): LiveFieldOptionsRead {
  const registry = useTaskCategories();
  return useMemo(() => mapResource(registry, toOptions), [registry]);
}

/**
 * The exposed `category` field of every list whose rows reach a task (the task
 * list): an enum over the registry's categories, NULL (no row) the "None"
 * bucket.
 */
export const categoryPresentation = FieldPresentation.Register({
  owner: taskCategoryShape.exposure,
  fields: { category: { useOptions: useTaskCategoryOptions } },
});
