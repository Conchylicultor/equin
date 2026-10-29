import { useCallback, useMemo } from "react";
import {
  mapRow,
  useLiveMutation,
  useLiveRow,
} from "@plugins/network/plugins/live/web";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import {
  launchDecisions,
  taskApprovalEndpoint,
  type LaunchDecision,
} from "../../core";

/**
 * One task's launch decision: `approved`, `excluded`, or `null` (undecided —
 * no row, never launched). Not loaded yet stays the loading arm, so an
 * approved task never flashes as unapproved.
 */
export function useTaskApproval(
  taskId: string,
): ResourceResult<LaunchDecision | null> {
  const result = useLiveRow(launchDecisions, taskId);
  return useMemo(
    () => mapRow(result, (row) => (row ? row.decision : null)),
    [result],
  );
}

/**
 * Approve a task for launch (overwriting an exclusion), or take the approval
 * back — which never erases an exclusion. A hook: the call goes over the
 * subtree's endpoint transport.
 */
export function useSetTaskApproval(): (
  taskId: string,
  approved: boolean,
) => void {
  const approval = useLiveMutation(taskApprovalEndpoint);
  return useCallback(
    (taskId, approved) =>
      approval.mutate({ params: { taskId }, body: { approved } }),
    [approval],
  );
}
