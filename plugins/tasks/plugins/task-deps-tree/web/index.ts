import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { TaskDetailSlots } from "@plugins/tasks/plugins/task-detail/web";
import {
  DepsTreeSection,
  useHasDepsCluster,
} from "./components/deps-tree-section";
import { DepsActions, DetachAction } from "./internal/deps-actions";
import {
  DepsSources,
  DepsSource,
  CreatedSource,
} from "./internal/deps-sources";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Dependency tree section for the task detail: a merged DataView whose sources render task_dependencies as a nesting = runs-after tree (atomic drag-to-reorder, per-row detach, 'also after' fan-in chips) or the read-only creation tree.",
  contributions: [
    TaskDetailSlots.Section({
      id: "deps-tree",
      // "Dependency tree", not "Dependencies": `tasks.task-dependencies` owns a
      // card by that name, and now that the host paints every title the two
      // would collide. The id is untouched (it keys the persisted order).
      label: "Dependency tree",
      component: DepsTreeSection,
      // Nothing but the task itself in the cluster ⇒ no card at all.
      useAvailable: useHasDepsCluster,
    }),
    DepsActions({ id: "detach", component: DetachAction }),
    // Both sources of the merged deps-tree surface are contributed here — the
    // slot and its contributors live in one plugin on purpose (nothing imports
    // deps-tree for this; the Created source composes task-list's exports).
    DepsSources({
      id: "deps",
      title: "Dependencies",
      icon: symbol("account-tree"),
      order: 5,
      views: ["table"],
      component: DepsSource,
    }),
    DepsSources({
      id: "created",
      title: "Created",
      icon: symbol("folder-open"),
      order: 10,
      views: ["table"],
      component: CreatedSource,
    }),
  ],
  slots: { actions: DepsActions, sources: DepsSources },
} satisfies PluginDefinition;
