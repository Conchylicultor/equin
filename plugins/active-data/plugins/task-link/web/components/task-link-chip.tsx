import { mapRow, useLive } from "@plugins/network/plugins/live/web";
import {
  foldResource,
  matchResource,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import type { IdReferentState } from "@plugins/ids/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { taskDetailPane } from "@plugins/tasks/plugins/task-detail/web";
import { taskRows } from "@plugins/tasks/plugins/tasks-core/core";
import { STATUS_META } from "@plugins/tasks/plugins/task-status/web";

export function TaskLinkChip({
  content,
}: {
  content: string;
  attrs: Record<string, string>;
}) {
  const taskId = content.trim();
  const result = mapRow(useLive(taskRows, { id: taskId }), (task) => task);
  const openPane = useOpenPane();

  if (!taskId) return null;

  const target = openPane.to(taskDetailPane, { taskId }, { mode: "push" });

  // While pending, render the degraded raw-id chip so it never disappears.
  return matchResource(result, {
    loading: () => (
      <LinkChip
        activation={target}
        tooltip={taskId}
        leading={<StatusDot colorClass="bg-muted-foreground/40" />}
      >
        <span className="font-mono">{taskId}</span>
      </LinkChip>
    ),
    ready: (task) => {
      // The dot colour comes from the one status-display table (task-status), so
      // this chip can never drift from the badge the task list shows.
      const statusClass = task
        ? STATUS_META[task.status].dotClass
        : "bg-muted-foreground/40";
      return (
        <LinkChip
          activation={target}
          tooltip={task ? `${task.title} · ${taskId}` : taskId}
          leading={<StatusDot colorClass={statusClass} />}
        >
          {task?.title ?? <span className="font-mono">{taskId}</span>}
        </LinkChip>
      );
    },
  });
}

/** The task presenter's referent read: the task's title, from its live row. */
export function useTaskReferent(taskId: string): IdReferentState {
  const result = mapRow(useLive(taskRows, { id: taskId }), (task) => task);
  return foldResource(result, {
    loading: (): IdReferentState => ({ status: "loading" }),
    error: (error): IdReferentState => ({ status: "failed", error }),
    ready: (task): IdReferentState => {
      return task
        ? { status: "found", title: task.title }
        : { status: "missing" };
    },
  });
}

/** The link to a task's detail pane beside the surface holding its id. */
export function useTaskTarget(): (taskId: string) => LinkTarget {
  const openPane = useOpenPane();
  return (taskId) => openPane.to(taskDetailPane, { taskId }, { mode: "push" });
}
