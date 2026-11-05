import { useMemo } from "react";
import { namespaceFromHost } from "@plugins/infra/plugins/namespace/core";
import { rowOrStale, useLive } from "@plugins/network/plugins/live/web";
import { attemptRows, taskRows } from "@plugins/tasks/plugins/tasks-core/core";
import type { HealthInfo } from "@plugins/shell/plugins/health-report/web";
import {
  identityInfo,
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
 * The task this page's checkout is working on: the attempt the checkout is
 * named after — a worktree lives at `<root>/<attemptId>` (conversations/
 * workspace's `pathFor`), so the checkout IS the attempt id — then that
 * attempt's task. Two point reads, one row each. (Checkouts made before
 * 2026-05-02 were named differently and read as unlinked; none still exists.)
 */
export function useLinkedTask(place: WorktreePlace): LinkedTask {
  const checkout = place.kind === "worktree" ? place.checkout : null;
  const attempt = useLive(attemptRows, { id: checkout });
  // The title lookup keys off the attempt's task id once it is known; until
  // then (or when the attempt read failed) it looks nothing up, and the answer
  // below comes from the attempt read's own state.
  const task = useLive(taskRows, { id: rowOrStale(attempt)?.taskId ?? null });

  if (checkout === null) return { kind: "none" };
  if (attempt.status === "loading") return { kind: "pending" };
  if (attempt.status === "error") return { kind: "failed" };
  if (!attempt.found) return { kind: "none" };
  if (task.status === "loading") return { kind: "pending" };
  if (task.status === "error") return { kind: "failed" };
  if (!task.found) return { kind: "none" };
  return { kind: "linked", taskId: attempt.row.taskId, title: task.row.title };
}

/** The health report's worktree row: `{ title, summary }` for this page. */
export function useWorktreeIdentity(): HealthInfo {
  const place = useWorktreePlace();
  return identityInfo(place, useLinkedTask(place));
}
