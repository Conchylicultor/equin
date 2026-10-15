import { useCallback } from "react";
import {
  combineResources,
  mapResource,
} from "@plugins/primitives/plugins/live-state/web";
import { mapRow } from "@plugins/network/plugins/live/web";
import type { ModelChoice } from "@plugins/conversations/plugins/model-provider/core";
import { setAutoStart } from "@plugins/tasks/web";
import { useTaskAttempts } from "@plugins/tasks/plugins/tasks-core/web";
import { useTaskAutoStart } from "@plugins/tasks/plugins/auto-start/web";
import type { LaunchBinding } from "@plugins/tasks/plugins/launch-options/web";

/**
 * Binds the control to an existing task's `tasks_ext_auto_start` row.
 *
 * Disabled while the task has an attempt the user has not finished with
 * (`retained`): that attempt already is the task's launch, so the server
 * refuses the arm. A closed attempt is a past run — arming asks for another.
 */
export function useTaskAutoStartBinding(
  taskId: string,
): LaunchBinding<ModelChoice | null> {
  // An absent row is "not armed".
  const model = mapRow(useTaskAutoStart(taskId), (row) =>
    row ? row.autoStartModel : null,
  );
  const attempts = useTaskAttempts(taskId);

  const onChange = useCallback(
    (next: ModelChoice | null) => void setAutoStart(taskId, next ?? "none"),
    [taskId],
  );

  return mapResource(
    combineResources({ model, attempts }),
    ({ model: value, attempts: list }) => ({
      value,
      onChange,
      disabledReason: list.some((a) => a.retained)
        ? "This task already has an open attempt. Auto-start applies once every attempt is closed."
        : undefined,
    }),
  );
}
