import { useMemo } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  useFetchEndpoint,
  type FetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web";
import {
  fieldOverrides,
  type HierarchyConfig,
} from "@plugins/primitives/plugins/data-view/web";
import type { RowMenuHelpers } from "@plugins/primitives/plugins/tree/core";
import { createTask, moveTask } from "@plugins/tasks/core";
import {
  taskRows,
  type TaskListItem,
} from "@plugins/tasks/plugins/tasks-core/core";
import { patchTask } from "@plugins/tasks/web";
import {
  StatusIcon,
  StatusBadge,
} from "@plugins/tasks/plugins/task-status/web";
import { Tasks } from "../slots";
import { symbol } from "@plugins/ui/plugins/icons/core";

const addIcon = symbol("add");

// The generic tree primitive speaks `parentId`; the tasks domain stores the
// display hierarchy as `folderId`. Map at this boundary so the primitive stays
// domain-neutral and the folder concept never leaks into it.
async function createTaskRow(
  fetchEndpoint: FetchEndpoint,
  args: {
    parentId: string | null;
    afterId?: string;
  },
): Promise<string> {
  const task = await fetchEndpoint(
    createTask,
    {},
    { body: { folderId: args.parentId, afterId: args.afterId } },
  );
  return task.id;
}

/**
 * THE task list schema: every task DataView spreads this one value into its
 * props/bundle, so no surface can drift from another (the drift that once
 * left the deps-tree without the track column). The fields are DERIVED from
 * the collection (`taskRows`, declared by fields over the `tasks` entity):
 * the title, status and last update, and every field a task extension
 * exposes — its track, category and automation (`origin`) — so a new
 * exposure joins every task list with no code here. The list says only how
 * three of them present (`fieldOverrides`, by id).
 *
 * A hook: the title edit writes through the enclosing subtree's transport (a
 * demo scope's worker, else the page's server). Stable per transport.
 */
export function useTaskFieldSchema() {
  const fetchEndpoint = useFetchEndpoint();
  return useMemo(
    () => ({
      collection: taskRows,
      overrides: fieldOverrides(taskRows, {
        title: {
          onEdit: (t, next) =>
            patchTask(fetchEndpoint, t.id, {
              title: String(next ?? "").trim() || "Untitled",
            }),
        },
        status: {
          align: "end",
          cell: (t) => <StatusBadge status={t.status} />,
        },
        updatedAt: { align: "end" },
      }),
    }),
    [fetchEndpoint],
  );
}

// No expand hooks. Expand/collapse is per-(surface, view-instance, row) device-
// local render state owned by the data-view primitive — never a domain field —
// so a collapse gesture costs no DB write and never touches `updatedAt`.
// Cluster variant: the read-only shape alone, for a scoped inspection tree (a
// dependency+creation cluster). Omitting `onMove` disables drag in the tree
// primitive; omitting `onCreate` removes the root "Add" and per-row add
// affordances. Isolation from the main Tasks list is automatic — the primitive
// keys its expand map by view instance — so nothing has to be stripped for it.
// Pairs with `buildTreeOptions({ defaultExpanded: true })`.
export const clusterTaskHierarchy: HierarchyConfig<TaskListItem> = {
  getParentId: (t) => t.folderId,
  getRank: (t) => t.rank,
};

/**
 * The editable task hierarchy: the cluster shape plus the two mutating hooks,
 * which write through the enclosing subtree's transport. Stable per transport.
 */
export function useTaskHierarchy(): HierarchyConfig<TaskListItem> {
  const fetchEndpoint = useFetchEndpoint();
  return useMemo<HierarchyConfig<TaskListItem>>(
    () => ({
      ...clusterTaskHierarchy,
      // Positional intent only. These rows are a projection of the tasks table
      // (filtered, searched, grouped by the view), so the rank is `moveTask`'s
      // to mint against the complete `folderId` sibling set.
      onMove: (id, dest) =>
        fetchEndpoint(
          moveTask,
          { id },
          {
            body: {
              folderId: dest.parentId,
              targetId: dest.targetId,
              zone: dest.zone,
            },
          },
        ),
      onCreate: (args) => createTaskRow(fetchEndpoint, args),
    }),
    [fetchEndpoint],
  );
}

export function buildTreeOptions({
  readOnly,
  defaultExpanded,
}: {
  readOnly?: boolean;
  defaultExpanded?: boolean;
}) {
  // The nested table's options (`viewOptions.table`).
  return {
    leadingIcon: (t: TaskListItem) => <StatusIcon status={t.status} />,
    labelClassName: (t: TaskListItem) =>
      cn(
        t.status === "dropped" &&
          "text-muted-foreground/70 line-through italic",
        t.status === "done" && "text-muted-foreground",
      ),
    expandAll: true,
    defaultExpanded,
    addLabel: readOnly ? null : "Add",
    toolbarStart: <Tasks.ListActions.Render />,
    // The per-row "Add item below" is an options-driven create affordance — drop
    // it under readOnly so no dead menu item survives the hierarchy's missing
    // onCreate.
    rowMenu: readOnly
      ? undefined
      : ({ addBelow }: RowMenuHelpers) => [
          {
            icon: addIcon,
            label: "Add item below",
            onClick: () => void addBelow(),
          },
        ],
    dragOverlay: (t: TaskListItem) => t.title || "Untitled",
  };
}
