import { useLive } from "@plugins/network/plugins/live/web";
import { attemptWorkspaces } from "@plugins/tasks/plugins/tasks-core/core";
import type { WorkspaceKindState } from "@plugins/conversations/plugins/workspace/core";

/**
 * The kind of the workspace an attempt runs in, once read — what the pane's
 * slot hosts gate each contribution's `requires` on.
 */
export function useAttemptWorkspaceKind(
  attemptId: string | null,
): WorkspaceKindState {
  const result = useLive(attemptWorkspaces, { id: attemptId });
  return result.status === "ready" && result.found
    ? { known: true, kind: result.row.workspace.kind }
    : { known: false };
}
