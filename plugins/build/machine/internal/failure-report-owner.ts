import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { buildDetailRoute } from "@plugins/build/core";
import { BUILD_RUN_KIND } from "@plugins/build/plugins/run-ledger/core";
import { linkRunReport } from "@plugins/build/plugins/failure-report/server";
import { runSubject } from "@plugins/runs/core";
import {
  findSubjectTask,
  TaskSubjectLinked,
} from "@plugins/tasks/plugins/task-subject/server";

/** A build run's page: its bell's link, and its failure report's occurrence `url`. */
export function buildRunLink(runId: string): string {
  return buildDetailRoute.link(agentManagerApp, { runId });
}

/** What a task about a build run is filed under (the runs list's Investigate, build-fix's). */
export function buildRunSubject(runId: string): { kind: string; id: string } {
  return runSubject({ kind: BUILD_RUN_KIND, id: runId });
}

/** The live task already filed about a run, `null` when there is none. */
export function buildRunTask(runId: string): Promise<string | null> {
  return findSubjectTask(buildRunSubject(runId));
}

/**
 * A task filed about a build run (its Investigate) owns the `build-failed`
 * report that run fell into — so the report carries the task that already
 * investigates it, and a supervisor does not start a second one.
 */
export const buildRunTaskOwnsReport = TaskSubjectLinked({
  id: "build.failure-report-owner",
  subjectKind: buildRunSubject("").kind,
  onLinked: (taskId, subject) =>
    linkRunReport(buildRunLink(subject.id), taskId),
});
