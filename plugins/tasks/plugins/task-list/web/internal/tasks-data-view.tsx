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
import type { LiveHierarchyConfig } from "@plugins/primitives/plugins/data-view/core";
import type { RowMenuHelpers } from "@plugins/primitives/plugins/tree/core";
import { createTask, moveTask } from "@plugins/tasks/core";
import {
  taskRows,
  taskWindow,
  type TaskListItem,
  type TaskTreeRow,
} from "@plugins/tasks/plugins/tasks-core/core";
import { usePatchTask } from "@plugins/tasks/web";
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
 * How a task list writes a title back: trimmed, an empty title "Untitled".
 * Through the enclosing subtree's transport (a demo scope's worker, else the
 * page's server).
 */
function useTitleEdit(): (t: TaskListItem, next: unknown) => Promise<void> {
  const patchTask = usePatchTask();
  return useMemo(
    () => (t, next) =>
      patchTask(t.id, { title: String(next ?? "").trim() || "Untitled" }),
    [patchTask],
  );
}

/**
 * THE task list schema over an in-memory set of `taskRows`' rows (the deps
 * tree's sources): every such DataView spreads this one value into its
 * props/bundle, so no surface can drift from another (the drift that once
 * left the deps-tree without the track column). The fields are DERIVED from
 * the collection (declared by fields over the `tasks` entity): the title,
 * status and last update, and every field a task extension exposes — its
 * track, category and automation (`origin`) — so a new exposure joins every
 * task list with no code here. Where each is drawn is the record recipe's:
 * the status (its options declare their tint and glyph) leads, the title is
 * the title, the last update sits at the edge. The list says only how the
 * title writes back (`fieldOverrides`, by id). Stable per transport.
 */
export function useTaskFieldSchema() {
  const onEdit = useTitleEdit();
  return useMemo(
    () => ({
      collection: taskRows,
      overrides: fieldOverrides(taskRows, { title: { onEdit } }),
    }),
    [onEdit],
  );
}

/**
 * The tasks tree's overrides (`TasksListView`, a live source over
 * `taskWindow` — the same fields as {@link useTaskFieldSchema}'s): the title
 * writes back, and `folderId` — listed only because a tree's parent is a
 * filterable column, which the tree's own reads filter on — is no field a
 * person picks: neither drawn, nor offered to filter, sort or group by (the
 * nesting IS the folder; drawn flat, data-view's derived Parent field names
 * it). Stable per transport.
 */
export function useTaskTreeOverrides() {
  const onEdit = useTitleEdit();
  return useMemo(
    () =>
      fieldOverrides(taskWindow, {
        title: { onEdit },
        folderId: {
          visible: false,
          filterable: false,
          sortable: false,
          groupable: false,
        },
      }),
    [onEdit],
  );
}

// No expand hooks. Expand/collapse is per-(surface, view-instance, row) device-
// local render state owned by the data-view primitive — never a domain field —
// so a collapse gesture costs no DB write and never touches `updatedAt`.
// The in-memory shape, for a scoped inspection tree over a set the reader holds
// whole (the deps tree's Created source: one dependency cluster). Omitting `onMove` disables drag in the tree
// primitive; omitting `onCreate` removes the root "Add" and per-row add
// affordances. Isolation from the main Tasks list is automatic — the primitive
// keys its expand map by view instance — so nothing has to be stripped for it.
// Pairs with `buildTreeOptions({ defaultExpanded: true })`.
export const clusterTaskHierarchy: HierarchyConfig<TaskListItem> = {
  getParentId: (t) => t.folderId,
  getRank: (t) => t.rank,
};

/**
 * The tasks tree's writes (`TasksListView`'s live `hierarchy`): its shape —
 * parent and rank — is the collection's (`taskWindow`'s `tree`), so only the
 * two mutating hooks are said here, written through the enclosing subtree's
 * transport. Stable per transport.
 */
export function useTaskTreeWrites(): LiveHierarchyConfig<TaskTreeRow> {
  const fetchEndpoint = useFetchEndpoint();
  return useMemo<LiveHierarchyConfig<TaskTreeRow>>(
    () => ({
      // Positional intent only. The tree holds a bounded projection of the
      // tasks table (paged levels, filtered, searched, grouped by the view),
      // so the rank is `moveTask`'s to mint against the complete `folderId`
      // sibling set.
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
    labelClassName: (t: TaskListItem) =>
      cn(
        t.status === "dropped" &&
          "text-muted-foreground/70 line-through italic",
        t.status === "done" && "text-muted-foreground",
      ),
    expandAll: true,
    defaultExpanded,
    addLabel: readOnly ? null : "Add",
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
