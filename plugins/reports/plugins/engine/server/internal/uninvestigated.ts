import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  isNull,
  notInArray,
} from "drizzle-orm";
import { db } from "@plugins/database/server";
import { _reports, ReportKind, type ReportRow } from "@plugins/reports/server";
import { reportsProducer } from "./producer";
import {
  fenceUntrustedReport,
  formatReportActivity,
  isUntrustedReportSource,
  reportActivity,
  reportIdKind,
  UNTRUSTED_REPORT_SOURCES,
} from "@plugins/reports/core";

// The worklist: what nobody is on — no task linked, not noise — among the
// reports that need a fix: open (no fix named yet) or regressed (the fix did
// not hold; its regression unlinked the old task, so it comes back here). A
// pending or fixed report is someone's fix, on its way or live.
//
// Never a report from an UNTRUSTED source (strangers wrote its content —
// `reports/core`'s UNTRUSTED_REPORT_SOURCES): every automation reads this
// worklist, and a crafted message is a prompt-injection vector into an agent
// with shell and repo access. Such a report is investigated only by hand.
const worklist = and(
  isNull(_reports.taskId),
  eq(_reports.noise, false),
  inArray(_reports.fixState, ["open", "regressed"]),
  notInArray(_reports.source, [...UNTRUSTED_REPORT_SOURCES]),
);

/**
 * How many worklist reports of each kind have occurred at least
 * `minCount` times — one GROUP BY, bounded by the registered kinds.
 */
export async function reportWorklistCounts(
  minCount: number,
): Promise<{ kind: string; reports: number }[]> {
  return db
    .select({
      kind: _reports.kind,
      reports: count(),
    })
    .from(_reports)
    .where(and(worklist, gte(_reports.count, minCount)))
    .groupBy(_reports.kind);
}

/**
 * The worklist reports of `kinds` that occurred at least `minCount`
 * times, oldest first, at most `limit`.
 */
export async function reportWorklist(args: {
  kinds: readonly string[];
  minCount: number;
  limit: number;
}): Promise<ReportRow[]> {
  return readWorklist(db, args);
}

/** {@link reportWorklist} over a given executor (a test's throwaway DB). */
export async function readWorklist(
  dbx: Pick<typeof db, "select">,
  args: { kinds: readonly string[]; minCount: number; limit: number },
): Promise<ReportRow[]> {
  if (args.kinds.length === 0) return [];
  return dbx
    .select()
    .from(_reports)
    .where(
      and(
        worklist,
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
  const { title, description } = spec.renderTask(row);
  // Every kind's body states the lifetime count; this line says what it is
  // doing now, so an investigator can tell a live problem from an old one.
  const activity = formatReportActivity(reportActivity(row, Date.now()));
  const body = `${description}\n\n**Activity:** ${activity}`;
  // Strangers wrote an untrusted report's content: the agent reads it as
  // data, never instructions. (An untrusted kind builds its title from typed,
  // identifier-shaped fields only — it is not fenced.)
  if (isUntrustedReportSource(row.source)) {
    return { title, description: fenceUntrustedReport(body) };
  }
  return { title, description: body };
}
