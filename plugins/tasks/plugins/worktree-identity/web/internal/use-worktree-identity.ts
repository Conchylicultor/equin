import { useCallback, useMemo } from "react";
import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import { namespaceFromHost } from "@plugins/infra/plugins/namespace/core";
import { mapRow, useLive } from "@plugins/network/plugins/live/web";
import {
  attemptRows,
  taskRows,
  type AttemptWithConversations,
} from "@plugins/tasks/plugins/tasks-core/core";
import type { HealthInfo } from "@plugins/shell/plugins/health-report/web";
import {
  identityInfo,
  linkedTaskIdOf,
  placeOf,
  type LinkedTask,
  type WorktreePlace,
} from "./identity";

/**
 * Where this page is served from. Read inside a hook rather than at module
 * scope, which would make the module unimportable without a DOM. The host
 * never changes for the life of the page, hence the empty deps.
 */
export function useWorktreePlace(): WorktreePlace {
  return useMemo(() => placeOf(namespaceFromHost(window.location.host)), []);
}

/**
 * The task this page's checkout is working on: the attempt whose worktree path
 * ends in the checkout, then that attempt's task.
 *
 * The attempt is a `select` over the resident attempt set, so this re-renders
 * when THIS checkout's link changes, not on every push to the global list (a
 * gated read, `useLive(all, { select })`, which keeps the pending → settled
 * flip reliable, since `pending` is an answer of its own here). The title is a
 * point read of the linked task's row.
 */
export function useLinkedTask(place: WorktreePlace): LinkedTask {
  const checkout = place.kind === "worktree" ? place.checkout : null;

  const selectTaskId = useCallback(
    (attempts: readonly AttemptWithConversations[]) =>
      checkout === null ? null : linkedTaskIdOf(attempts, checkout),
    [checkout],
  );
  // `useLive(all, { select })` is a gated read already.
  const attempt = useLive(attemptRows, { select: selectTaskId });

  // The title lookup keys off the attempt's task id once it is known; until
  // then (or when the attempts read failed) it looks nothing up, and the answer
  // below comes from the attempt read's own state.
  const taskId = foldResource(attempt, {
    loading: () => null,
    error: () => null,
    ready: (id) => id,
  });
  const task = mapRow(
    useLive(taskRows, { id: taskId }),
    (row) => row?.title ?? null,
  );

  if (checkout === null) return { kind: "none" };
  if (attempt.status === "loading") return { kind: "pending" };
  if (attempt.status === "error") return { kind: "failed" };
  if (attempt.data === null) return { kind: "none" };
  if (task.status === "loading") return { kind: "pending" };
  if (task.status === "error") return { kind: "failed" };
  if (task.data === null) return { kind: "none" };
  return { kind: "linked", taskId: attempt.data, title: task.data };
}

/** The health report's worktree row: `{ title, summary }` for this page. */
export function useWorktreeIdentity(): HealthInfo {
  const place = useWorktreePlace();
  return identityInfo(place, useLinkedTask(place));
}
