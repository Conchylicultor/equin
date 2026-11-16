import { and, eq, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { _reports } from "@plugins/reports/server";
import { linkReportsToTask } from "@plugins/reports/plugins/engine/server";
import { BUILD_FAILED_KIND } from "../../core";

/**
 * Make `taskId` the owner of the `build-failed` report a run fell into: the
 * report one of whose kept occurrences (`recent`) is this run's — found by the
 * run's page, which every occurrence carries as its `url`. The newest owner
 * wins: an investigation of a later run of the same failure takes the report
 * over from a finished one. A report already owned stops reaching the Error
 * reports stream (the engine announces only unowned reports), so a supervisor
 * does not start a second investigation.
 *
 * Nothing to link when the run filed no report (a worktree's build, a
 * superseded or killed one) or its occurrence aged out of `recent`.
 */
export async function linkRunReport(
  runUrl: string,
  taskId: string,
): Promise<void> {
  await linkReportsToTask(await runReportIds(runUrl), taskId);
}

/**
 * The `build-failed` reports one of whose kept occurrences is the run at
 * `runUrl` — at most one: a run files one occurrence.
 */
export async function runReportIds(runUrl: string): Promise<string[]> {
  const rows = await db
    .select({ id: _reports.id })
    .from(_reports)
    .where(
      and(
        eq(_reports.kind, BUILD_FAILED_KIND),
        sql`${_reports.recent} @> ${JSON.stringify([{ url: runUrl }])}::jsonb`,
      ),
    );
  return rows.map((r) => r.id);
}
