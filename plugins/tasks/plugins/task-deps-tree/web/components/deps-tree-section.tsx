import { useLive } from "@plugins/network/plugins/live/web";
import { useCallback, useMemo } from "react";
import {
  foldResource,
  ResourceView,
} from "@plugins/primitives/plugins/live-state/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import {
  DataViewSwitcher,
  defineDataView,
} from "@plugins/primitives/plugins/data-view/web";
import { taskRows, type TaskRow } from "@plugins/tasks/plugins/tasks-core/core";
import { taskDetailPane } from "@plugins/tasks/plugins/task-detail/web";
import { taskClusterIds } from "@plugins/tasks/plugins/task-deps-tree/core";
import { DepsSources } from "../internal/deps-sources";

// The merged DataView surface id — the config lives under this plugin's tree at
// `config/tasks/task-deps-tree/task-deps-tree.jsonc`.
const DEPS_TREE_VIEW = defineDataView("task-deps-tree");

/**
 * The cluster is just the task itself ⇒ there is no tree to draw. Declared as
 * the contribution's `useAvailable` rather than a `return null` below: the host
 * paints the card before it reaches the body, so a null there would leave a
 * "Dependency tree" bar that opens onto nothing.
 *
 * Self-hide is a property of the CLUSTER, never of the selected task's own
 * edges — see the note on the same gate below.
 */
export function useHasDepsCluster({ taskId }: { taskId: string }): boolean {
  const result = useLive(taskRows);
  // Still loading ⇒ keep the card painted (the body shows its own Loading), so
  // it does not pop in a frame after the pane. `false` here would collapse
  // "unknown yet" into "definitely a lone task". Failed ⇒ painted too: the
  // body renders the failure with Retry.
  return foldResource(result, {
    loading: () => true,
    error: () => true,
    ready: (tasks) => taskClusterIds(tasks, taskId).size > 1,
  });
}

export function DepsTreeSection({ taskId }: { taskId: string }) {
  const result = useLive(taskRows);
  return (
    <ResourceView resource={result}>
      {(allTasks) => (
        <DepsTreeSectionLoaded taskId={taskId} allTasks={allTasks} />
      )}
    </ResourceView>
  );
}

function DepsTreeSectionLoaded({
  taskId,
  allTasks,
}: {
  taskId: string;
  allTasks: readonly TaskRow[];
}) {
  // Selecting a task in the tree re-roots this pane in place, so the URL stays
  // truthful and the new root is shareable.
  const openPane = useOpenPane();
  const linkTo = useCallback(
    (id: string) =>
      openPane.to(taskDetailPane, { taskId: id }, { mode: "swap" }),
    [openPane],
  );

  // The single member set both sources render — one set, organized two ways.
  const memberIds = useMemo(
    () => taskClusterIds(allTasks, taskId),
    [allTasks, taskId],
  );

  // Self-hide is a property of the CLUSTER, never of the selected task's own
  // edges. This section renders `memberIds`, so gating on anything else lets the
  // two drift: a deps-tree move rewires only the moved task's dependency edges,
  // which a task-scoped gate reads as "no longer relevant" and hides the section
  // — while the member set it was rendering did not change at all. Deriving the
  // gate from the rendered set makes that class of bug impossible: the section
  // hides exactly when there is nothing but the task itself to draw.
  //
  // `useHasDepsCluster` is that same derivation, hoisted to `useAvailable` so
  // the card itself disappears instead of opening onto nothing.
  if (memberIds.size <= 1) return null;

  // ONE merged DataView surface: the Dependencies / Created organisations are
  // contributed sources, unified under a single switcher + config file.
  return (
    <DataViewSwitcher
      storageKey={DEPS_TREE_VIEW}
      sources={DepsSources}
      hostProps={{ taskId, allTasks, memberIds, linkTo }}
      defaultView="deps"
    />
  );
}
