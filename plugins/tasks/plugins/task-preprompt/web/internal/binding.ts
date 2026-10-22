import { useCallback } from "react";
import { mapRow } from "@plugins/network/plugins/live/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import type { LaunchBinding } from "@plugins/tasks/plugins/launch-options/web";
import { useTaskPreprompt } from "../hooks";
import { setTaskPrepromptRemote } from "./api";

/** Binds the control to an existing task's `tasks_ext_preprompt` row. */
export function useTaskPrepromptBinding(
  taskId: string,
): LaunchBinding<string | null> {
  const result = useTaskPreprompt(taskId);
  const fetchEndpoint = useFetchEndpoint();
  const toast = useToast();

  const onChange = useCallback(
    (prepromptId: string | null) => {
      setTaskPrepromptRemote(fetchEndpoint, taskId, prepromptId).catch(
        (err: unknown) => {
          toast({
            type: "task",
            title: "Failed to set preprompt",
            description: err instanceof Error ? err.message : String(err),
            variant: "error",
          });
        },
      );
    },
    [taskId, fetchEndpoint, toast],
  );

  // An absent row is "no preprompt"; loading / error pass through.
  return mapRow(result, (row) => ({
    value: row?.prepromptId ?? null,
    onChange,
  }));
}
