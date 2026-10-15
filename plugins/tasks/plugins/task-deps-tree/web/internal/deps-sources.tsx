import { useMemo, type ReactElement } from "react";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import {
  defineDataViewSources,
  type DataViewSourceProps,
  type HierarchyConfig,
} from "@plugins/primitives/plugins/data-view/web";
import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import type { TaskRow } from "@plugins/tasks/plugins/tasks-core/core";
import { moveTaskInDepsTree } from "@plugins/tasks/core";
import {
  Tasks,
  taskFieldSchema,
  clusterTaskHierarchy,
  buildTreeOptions,
} from "@plugins/tasks/plugins/task-list/web";
import {
  buildDepsTree,
  type DepsTreeRow,
} from "@plugins/tasks/plugins/task-deps-tree/core";
import { depsTreeOptions } from "./deps-tree-options";
import { DepsActions } from "./deps-actions";

/** The host props the deps-tree section threads to both sources. */
export interface DepsHostProps {
  taskId: string;
  allTasks: readonly TaskRow[];
  memberIds: ReadonlySet<string>;
  /** Where a row goes: a link, so middle- / ⌘-click open it in a browser tab. */
  linkTo: (id: string) => LinkTarget;
}

/**
 * The source slot for the merged deps-tree DataView. Both sources are
 * contributed by this plugin's own `web/index.ts` — nothing ever imports
 * deps-tree for this, so the existing `task-deps-tree → task-list` import
 * direction is preserved (the Created source composes from task-list's exported
 * building blocks, which is the supported reuse path: a source's `render(bundle)`
 * IS the inner DataView, so a component that owns its own cannot be a source).
 */
export const DepsSources = defineDataViewSources<DepsHostProps>();

// Every `task_dependencies` edge is a literal tree edge, so the tree's shape IS
// the dependency relation. The drop's anchor is read as an edge intent rather
// than a position: a drop ONTO a row (`targetId === null`) splices into the
// chain; a sibling-zone drop branches. The server rewires the edges atomically.
const depsHierarchy: HierarchyConfig<DepsTreeRow> = {
  getParentId: (r) => r.depsParentId,
  getRank: (r) => r.rank,
  onMove: (id, dest) =>
    fetchEndpoint(
      moveTaskInDepsTree,
      { id },
      {
        body: {
          newParentId: dest.parentId,
          mode: dest.targetId === null ? "splice" : "branch",
        },
      },
    ),
};

/**
 * The Dependencies source: the cluster organised by its `task_dependencies`
 * edges (nesting = runs-after), with atomic drag-to-rewire and the
 * 'also after' fan-in chips.
 */
export function DepsSource({
  hostProps,
  render,
}: DataViewSourceProps<DepsHostProps>): ReactElement {
  const { taskId, allTasks, memberIds, linkTo } = hostProps;
  const rows = useMemo(
    () => buildDepsTree(allTasks, memberIds),
    [allTasks, memberIds],
  );
  return (
    <>
      {render<DepsTreeRow<TaskRow>>({
        rows,
        // The rows are `taskRows`' (each task's row, spread with its tree
        // edge), so the schema is the task list's — derived from it.
        ...taskFieldSchema,
        rowKey: (r) => r.id,
        hierarchy: depsHierarchy,
        viewOptions: { table: depsTreeOptions },
        itemActions: DepsActions,
        selectedRowId: taskId,
        rowActivation: (r) => linkTo(r.id),
      })}
    </>
  );
}

/**
 * The Created source: the same cluster organised by its creation structure
 * (`folderId` forest) — read-only, ephemeral expand state, every node open by
 * default. Composed from task-list's exported building blocks.
 */
export function CreatedSource({
  hostProps,
  render,
}: DataViewSourceProps<DepsHostProps>): ReactElement {
  const { taskId, allTasks, memberIds, linkTo } = hostProps;
  // The rows are already the exact member set, so no subtree scoping —
  // out-of-set parents make their children render as roots (the creation forest).
  const rows = useMemo(
    () => allTasks.filter((t) => memberIds.has(t.id)),
    [allTasks, memberIds],
  );
  const treeOptions = useMemo(
    () => buildTreeOptions({ readOnly: true, defaultExpanded: true }),
    [],
  );
  return (
    <>
      {render<TaskRow>({
        rows,
        ...taskFieldSchema,
        rowKey: (t) => t.id,
        hierarchy: clusterTaskHierarchy,
        viewOptions: { table: treeOptions },
        selection: {},
        itemActions: Tasks.TaskActions,
        selectedRowId: taskId,
        rowActivation: (t) => linkTo(t.id),
      })}
    </>
  );
}
