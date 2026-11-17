import type { TaskSubject } from "@plugins/tasks/plugins/task-subject/core";

/**
 * The record an update task is ABOUT: one upstream release, by its tag. Both
 * ways an update is filed — the health row's "Send agent to update" and the
 * Upstream merges automation — name it, so each finds the other's task
 * (`tasks/task-subject`: a launch about a subject with a live task reuses it)
 * and the row follows whichever agent is merging that release.
 */
export function upstreamReleaseSubject(latest: string): TaskSubject {
  return { kind: "upstream-release", id: latest };
}
