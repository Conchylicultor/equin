import { and, asc, count, eq, gte, inArray, isNull } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { _reports, ReportKind, type ReportRow } from "@plugins/reports/server";
import { reportsProducer } from "./producer";
import { reportIdKind } from "@plugins/reports/core";

// Not yet investigated: no task linked, and not classified as noise.
const uninvestigated = and(isNull(_reports.taskId), eq(_reports.noise, false));

/**
 * How many uninvestigated reports of each kind have occurred at least
 * `minCount` times — one GROUP BY, bounded by the registered kinds.
 */
export async function uninvestigatedReportCounts(
  minCount: number,
): Promise<{ kind: string; reports: number }[]> {
  return db
    .select({
      kind: _reports.kind,
      reports: count(),
    })
    .from(_reports)
    .where(and(uninvestigated, gte(_reports.count, minCount)))
    .groupBy(_reports.kind);
}

/**
 * The uninvestigated reports of `kinds` that occurred at least `minCount`
 * times, oldest first, at most `limit`.
 */
export async function uninvestigatedReports(args: {
  kinds: readonly string[];
  minCount: number;
  limit: number;
}): Promise<ReportRow[]> {
  if (args.kinds.length === 0) return [];
  return db
    .select()
    .from(_reports)
    .where(
      and(
        uninvestigated,
        gte(_reports.count, args.minCount),
        inArray(_reports.kind, [...args.kinds]),
      ),
    )
    .orderBy(asc(_reports.firstSeenAt))
    .limit(args.limit);
}

/** Link every report in `reportIds` to the task investigating them. */
export async function linkReportsToTask(
  reportIds: readonly string[],
  taskId: string,
): Promise<void> {
  if (reportIds.length === 0) return;
  // `interactive`: the Reports pane should show "View task" on these rows as
  // soon as the task exists, not after the producer's 2 s window.
  await reportsProducer.mutate(
    db,
    (q, t) =>
      q
        .update(t)
        .set({ taskId })
        .where(inArray(t.id, [...reportIds].map(reportIdKind.key))),
    { latency: "interactive" },
  );
}

/**
 * A report as its kind renders it for an investigating agent — the same
 * title and body Investigate files. Throws for a kind with no registered spec.
 */
export function renderReportTask(row: ReportRow): {
  title: string;
  description: string;
} {
  const spec = ReportKind.getContributions().find((k) => k.kind === row.kind);
  if (!spec) {
    throw new Error(
      `renderReportTask: no ReportKind registered for kind "${row.kind}"`,
    );
  }
  return spec.renderTask(row);
}
