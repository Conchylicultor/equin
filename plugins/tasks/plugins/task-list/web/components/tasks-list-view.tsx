import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceView } from "@plugins/primitives/plugins/live-state/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  DataView,
  defineDataView,
} from "@plugins/primitives/plugins/data-view/web";
import { taskRows, type TaskRow } from "@plugins/tasks/plugins/tasks-core/core";
import { Tasks } from "../slots";
import {
  useTaskFieldSchema,
  useTaskHierarchy,
  buildTreeOptions,
} from "../internal/tasks-data-view";

const TASKS_LIST_VIEW = defineDataView("tasks-list");

export function TasksListView({
  selectedId,
  linkTo,
}: {
  selectedId?: string;
  /** Where a row goes: a link, so middle- / ⌘-click open it in a browser tab. */
  linkTo: (id: string) => LinkTarget;
}) {
  const result = useLive(taskRows);
  const taskFieldSchema = useTaskFieldSchema();
  const taskHierarchy = useTaskHierarchy();
  return (
    <ResourceView resource={result} fallback={<Loading variant="rows" />}>
      {(rows) => (
        <DataView<TaskRow>
          rows={rows}
          {...taskFieldSchema}
          rowKey={(t) => t.id}
          views={["table", "list"]}
          defaultView="tree"
          storageKey={TASKS_LIST_VIEW}
          selectedRowId={selectedId}
          rowActivation={(t) => linkTo(t.id)}
          selection={{}}
          hierarchy={taskHierarchy}
          viewOptions={{ table: buildTreeOptions({}), list: {} }}
          itemActions={Tasks.TaskActions}
          emptyState="No tasks yet."
        />
      )}
    </ResourceView>
  );
}
