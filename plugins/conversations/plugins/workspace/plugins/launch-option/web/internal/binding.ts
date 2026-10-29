import { useCallback } from "react";
import {
  combineResources,
  mapResource,
} from "@plugins/primitives/plugins/live-state/web";
import {
  mapRow,
  useLiveMutation,
  useLiveRow,
} from "@plugins/network/plugins/live/web";
import { useTaskAttempts } from "@plugins/tasks/plugins/tasks-core/web";
import type { LaunchBinding } from "@plugins/tasks/plugins/launch-options/web";
import type { WorkspaceSpec } from "@plugins/conversations/plugins/workspace/core";
import { deleteTaskWorkspace, putTaskWorkspace } from "../../shared/endpoints";
import { taskWorkspaces } from "../../shared/schemas";

/**
 * Binds the control to an existing task's `tasks_ext_workspace` row.
 *
 * Disabled while the task has an attempt the user has not finished with: that
 * attempt's workspace is fixed, and its next conversations reuse it. A closed
 * attempt is a past run — the choice applies to the next one.
 */
export function useTaskWorkspaceBinding(
  taskId: string,
): LaunchBinding<WorkspaceSpec | null> {
  // An absent row is the default worktree.
  const spec = mapRow(useLiveRow(taskWorkspaces, taskId), (row) =>
    row ? row.spec : null,
  );
  const attempts = useTaskAttempts(taskId);
  const put = useLiveMutation(putTaskWorkspace);
  const clear = useLiveMutation(deleteTaskWorkspace);

  const onChange = useCallback(
    (next: WorkspaceSpec | null) => {
      if (next) put.mutate({ params: { taskId }, body: { spec: next } });
      else clear.mutate({ params: { taskId } });
    },
    [taskId, put, clear],
  );

  return mapResource(
    combineResources({ spec, attempts }),
    ({ spec: value, attempts: list }) => ({
      value,
      onChange,
      disabledReason: list.some((a) => a.retained)
        ? "This task already has an open attempt, which keeps its workspace. The choice applies once every attempt is closed."
        : undefined,
    }),
  );
}
