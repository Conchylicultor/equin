import { useCallback } from "react";
import { mapRow } from "@plugins/network/plugins/live/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import type { EffortLevel } from "@plugins/conversations/plugins/effort-provider/core";
import type { LaunchBinding } from "@plugins/tasks/plugins/launch-options/web";
import { useTaskEffort } from "../hooks";
import { setTaskEffortRemote } from "./api";

/** Binds the control to an existing task's `tasks_ext_effort` row. */
export function useTaskEffortBinding(
  taskId: string,
): LaunchBinding<EffortLevel | null> {
  const result = useTaskEffort(taskId);
  const fetchEndpoint = useFetchEndpoint();
  const toast = useToast();

  const onChange = useCallback(
    (level: EffortLevel | null) => {
      setTaskEffortRemote(fetchEndpoint, taskId, level).catch(
        (err: unknown) => {
          toast({
            type: "task",
            title: "Failed to set thinking mode",
            description: err instanceof Error ? err.message : String(err),
            variant: "error",
          });
        },
      );
    },
    [taskId, fetchEndpoint, toast],
  );

  // An absent row is "no thinking mode chosen"; loading / error pass through.
  return mapRow(result, (row) => ({ value: row?.level ?? null, onChange }));
}
