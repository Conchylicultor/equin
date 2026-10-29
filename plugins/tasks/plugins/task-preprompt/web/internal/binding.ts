import { useCallback } from "react";
import { mapRow, useLiveMutation } from "@plugins/network/plugins/live/web";
import type { LaunchBinding } from "@plugins/tasks/plugins/launch-options/web";
import { deleteTaskPreprompt, putTaskPreprompt } from "../../shared/endpoints";
import { useTaskPreprompt } from "../hooks";

/** Binds the control to an existing task's `tasks_ext_preprompt` row. */
export function useTaskPrepromptBinding(
  taskId: string,
): LaunchBinding<string | null> {
  const result = useTaskPreprompt(taskId);
  const put = useLiveMutation(putTaskPreprompt);
  const clear = useLiveMutation(deleteTaskPreprompt);

  const onChange = useCallback(
    (prepromptId: string | null) => {
      if (prepromptId) {
        put.mutate({ params: { taskId }, body: { prepromptId } });
      } else {
        clear.mutate({ params: { taskId } });
      }
    },
    [taskId, put, clear],
  );

  // An absent row is "no preprompt"; loading / error pass through.
  return mapRow(result, (row) => ({
    value: row?.prepromptId ?? null,
    onChange,
  }));
}
