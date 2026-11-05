import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import {
  DataView,
  defineDataView,
  liveDataSource,
} from "@plugins/primitives/plugins/data-view/web";
import {
  taskWindow,
  type TaskTreeRow,
} from "@plugins/tasks/plugins/tasks-core/core";
import { Tasks } from "../slots";
import {
  useTaskTreeOverrides,
  useTaskTreeWrites,
  buildTreeOptions,
} from "../internal/tasks-data-view";

const TASKS_LIST_VIEW = defineDataView("tasks-list");

/**
 * The tasks tree, read live and bounded: the root level a paged window, each
 * open task's children a window of their own, a filter or a search its hits
 * with their folder chains (data-view's live trees over `taskWindow`, a
 * `tree` collection) — never the whole set of tasks.
 */
const TASKS_SOURCE = liveDataSource(taskWindow, {
  surface: TASKS_LIST_VIEW,
  searchable: ["title"],
  unscoped: {
    reason:
      "the task list sorts and filters on the server, which holds no custom columns for tasks yet",
  },
});

const TREE_OPTIONS = buildTreeOptions({});

export function TasksListView({
  selectedId,
  linkTo,
}: {
  selectedId?: string;
  /** Where a row goes: a link, so middle- / ⌘-click open it in a browser tab. */
  linkTo: (id: string) => LinkTarget;
}) {
  const overrides = useTaskTreeOverrides();
  const writes = useTaskTreeWrites();
  return (
    <DataView<TaskTreeRow>
      source={TASKS_SOURCE}
      overrides={overrides}
      views={["table", "list"]}
      defaultView="tree"
      selectedRowId={selectedId}
      rowActivation={(t) => linkTo(t.id)}
      selection={{}}
      hierarchy={writes}
      viewOptions={{ table: TREE_OPTIONS, list: {} }}
      itemActions={Tasks.TaskActions}
      emptyState="No tasks yet."
    />
  );
}
