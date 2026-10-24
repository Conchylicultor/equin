import { useLiveRow } from "@plugins/network/plugins/live/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { navIcons } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { taskRows } from "@plugins/tasks/plugins/tasks-core/core";
import type { TaskId } from "@plugins/tasks/plugins/task-ids/core";
import {
  STATUS_META,
  StatusIcon,
} from "@plugins/tasks/plugins/task-status/web";
import { taskDetailPane } from "@plugins/tasks/plugins/task-detail/web";

const openIcon = navIcons.expand;

/**
 * A task the help agent filed, as the live task: its status and title; a
 * click opens it in the Agent Manager. Read by the id the tool handed back
 * (the call's output, `askFiledTask`).
 *
 * Not found means deleted, never "not there yet": the tool created the task
 * (committed) before it returned, and this card exists only once the
 * transcript holds that return — so the point read, issued after, can only
 * miss a task that was since deleted. Until it answers, it is loading.
 */
export function FiledTaskCard({
  taskId,
  title: filedTitle,
}: {
  taskId: TaskId;
  /** The title it was filed with — named when the task is gone. */
  title: string;
}) {
  const task = useLiveRow(taskRows, taskId);
  const openPane = useOpenPane();
  if (task.status === "loading") return <Loading variant="rows" count={1} />;
  if (task.status === "error")
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the filed task"
        error={task.error}
        refetch={task.refetch}
      />
    );
  if (!task.found)
    return (
      <Text as="div" variant="caption" tone="muted">
        {`The task "${filedTitle}" is no longer in the task list.`}
      </Text>
    );
  const { id, title, status } = task.row;
  return (
    <Line
      as="a"
      {...openPane.link(taskDetailPane, { taskId: id }, { mode: "push" })}
      title="Open in Agent Manager"
      className="w-full gap-xs rounded-md border border-border px-sm py-xs text-left hover:bg-hover-fill"
    >
      <StatusIcon status={status} />
      <Fill>
        <Text variant="label" tone="strong">
          {title}
        </Text>
      </Fill>
      <Text variant="caption" tone="muted">
        {STATUS_META[status].label}
      </Text>
      <Icon icon={openIcon} className="size-3.5 text-muted-foreground" />
    </Line>
  );
}
