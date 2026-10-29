import { useCallback } from "react";
import { mapRow, useLiveMutation } from "@plugins/network/plugins/live/web";
import type { EffortLevel } from "@plugins/conversations/plugins/effort-provider/core";
import type { LaunchBinding } from "@plugins/tasks/plugins/launch-options/web";
import { deleteTaskEffort, putTaskEffort } from "../../shared/endpoints";
import { useTaskEffort } from "../hooks";

/** Binds the control to an existing task's `tasks_ext_effort` row. */
export function useTaskEffortBinding(
  taskId: string,
): LaunchBinding<EffortLevel | null> {
  const result = useTaskEffort(taskId);
  const put = useLiveMutation(putTaskEffort);
  const clear = useLiveMutation(deleteTaskEffort);

  const onChange = useCallback(
    (level: EffortLevel | null) => {
      if (level) put.mutate({ params: { taskId }, body: { level } });
      else clear.mutate({ params: { taskId } });
    },
    [taskId, put, clear],
  );

  // An absent row is "no thinking mode chosen"; loading / error pass through.
  return mapRow(result, (row) => ({ value: row?.level ?? null, onChange }));
}
