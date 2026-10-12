import { serveValue } from "@plugins/network/plugins/live/server";
import type { TaskCategoryDef } from "@plugins/tasks/plugins/task-category/core";
import { taskCategoryRegistry } from "../../shared/resources";
import { TaskCategory } from "./contribution";

// Every filing plugin contributes its category at load time, so the set is
// fixed for the process. Sorted by `order ?? 0` then id so section order is
// deterministic.
function loadRegistry(): TaskCategoryDef[] {
  return [...TaskCategory.getContributions()]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id))
    .map(({ id, label, order }) => ({ id, label, order }));
}

// External: the truth is the server's contribution registry, not Postgres.
export const taskCategoryRegistryServed = serveValue(taskCategoryRegistry, {
  source: "external",
  changes: {
    fixed: {
      reason:
        "the categories are TaskCategory plugin contributions, registered once per process",
    },
  },
  loader: loadRegistry,
});
