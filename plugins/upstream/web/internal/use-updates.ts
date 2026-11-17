import { useLive } from "@plugins/network/plugins/live/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import {
  attemptRows,
  type AttemptWithConversations,
} from "@plugins/tasks/plugins/tasks-core/core";
import { useSubjectTask } from "@plugins/tasks/plugins/task-subject/web";
import { upstreamReleaseStatus } from "@plugins/upstream/plugins/release/core";
import { upstreamReleaseSubject } from "../../shared/subject";
import {
  deriveUpdatesView,
  updatesHealth,
  type MergeRun,
  type UpdatesView,
} from "./updates-view";

/** The runs of one task, oldest first, cut to what the row shows. */
const runsOf = (attempts: readonly AttemptWithConversations[]): MergeRun[] =>
  attempts
    .flatMap((attempt) => attempt.conversations)
    .sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt))
    .map((c) => ({ id: c.id, status: c.status }));

/**
 * The updates row's state (see `UpdatesView`), from the pushed release
 * status, the live task about its newest release and that task's runs —
 * every read resident and pushed, so it is cheap enough for the always-on
 * probe.
 */
export function useUpdatesView(): UpdatesView {
  const release = useLive(upstreamReleaseStatus);
  // Only a release still to merge has a merge task to follow; otherwise the
  // subject read is skipped (pending, never read) — the derivation never
  // looks at it then.
  const latest =
    release.status === "ready" && release.data.kind === "behind"
      ? release.data.latest
      : null;
  const task = useSubjectTask(
    latest === null ? null : upstreamReleaseSubject(latest),
  );
  const taskId = task.status === "ready" ? task.data.taskId : null;
  const runs = useLive(attemptRows, {
    where: taskId === null ? null : { taskId },
    select: runsOf,
  });
  return deriveUpdatesView({ release, task, runs });
}

/** The row's `useStatus`. */
export function useUpdatesHealth(): HealthStatus {
  return updatesHealth(useUpdatesView());
}
