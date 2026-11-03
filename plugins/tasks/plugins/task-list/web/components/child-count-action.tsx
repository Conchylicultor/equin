import { useLive } from "@plugins/network/plugins/live/web";
import { useMemo } from "react";
import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import {
  taskRows,
  type TaskListItem,
} from "@plugins/tasks/plugins/tasks-core/core";

export function ChildCountAction({
  row,
  hasChildren,
}: ItemActionProps<TaskListItem>) {
  const taskId = row.id;
  const result = useLive(taskRows);
  // No count until the task list is known — never a stand-in `0`. A failed
  // read shows none either: the list this row sits in reads the same resource
  // and renders the failure.
  const count = useMemo(
    () =>
      foldResource(result, {
        loading: () => null,
        error: () => null,
        ready: (tasks) => tasks.filter((t) => t.folderId === taskId).length,
      }),
    [result, taskId],
  );

  if (!hasChildren || count === null) return null;

  return (
    // eslint-disable-next-line layout/no-adhoc-layout -- rigid count leaf inside the data-view item-actions flex cluster (owned by Row); must never shrink
    <span className="shrink-0 text-3xs tabular-nums text-muted-foreground">
      {count}
    </span>
  );
}
