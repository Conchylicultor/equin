import { useCallback } from "react";
import { mapRow, useLiveRow } from "@plugins/network/plugins/live/web";
import { toast } from "@plugins/shell/plugins/notifications/web";
import type { ConversationRuntimeId } from "@plugins/conversations/plugins/runtime-catalog/core";
import type { LaunchBinding } from "@plugins/tasks/plugins/launch-options/web";
import { taskRuntimes } from "../../shared/schemas";
import { setTaskRuntimeRemote } from "./api";

/** Binds the control to an existing task's `tasks_ext_runtime` row. */
export function useTaskRuntimeBinding(
  taskId: string,
): LaunchBinding<ConversationRuntimeId | null> {
  const onChange = useCallback(
    (next: ConversationRuntimeId | null) => {
      setTaskRuntimeRemote(taskId, next).catch((err: unknown) => {
        toast({
          type: "task",
          title: "Failed to set runtime",
          description: err instanceof Error ? err.message : String(err),
          variant: "error",
        });
      });
    },
    [taskId],
  );
  // An absent row is the configured default; loading / error pass through.
  return mapRow(useLiveRow(taskRuntimes, taskId), (row) => ({
    value: row?.runtime ?? null,
    onChange,
  }));
}
