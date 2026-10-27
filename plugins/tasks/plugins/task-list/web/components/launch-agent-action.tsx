import { LaunchControl } from "@plugins/primitives/plugins/launch/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import type { TaskListItem } from "@plugins/tasks/plugins/tasks-core/core";

export function LaunchAgentAction({ row }: ItemActionProps<TaskListItem>) {
  // The prompt is the task's own text, built by the server at launch.
  const getRequest = () => ({
    taskId: row.id,
    prompt: { from: "task" as const },
  });

  return (
    <LaunchControl size="icon" openAfterLaunch={false} getRequest={getRequest} />
  );
}
