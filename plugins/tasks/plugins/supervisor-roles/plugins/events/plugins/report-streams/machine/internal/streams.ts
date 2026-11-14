import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { reportIdKind, type ReportCategory } from "@plugins/reports/core";
import { _reports, ReportKind, ReportRecorded } from "@plugins/reports/server";
import { parseSavedSymbolName } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import { SupervisorEventStream } from "@plugins/tasks/plugins/supervisor-roles/plugins/events/server";
import { publishSupervisorEvent } from "@plugins/tasks/plugins/supervisor-roles/plugins/events/machine";

/** The stream each report category feeds. */
const STREAM_OF: Record<ReportCategory, string> = {
  error: "error-reports",
  "slow-op": "slow-op-reports",
};

function kindsOf(category: ReportCategory): string[] {
  return ReportKind.getContributions()
    .filter((k) => k.meta.category === category)
    .map((k) => k.kind);
}

export const errorReportsStream = SupervisorEventStream({
  id: STREAM_OF.error,
  label: "Error reports",
  icon: parseSavedSymbolName("bug-report"),
  description: "Crashes, failed requests and broken invariants main records",
  kinds: () => kindsOf("error"),
});

export const slowOpReportsStream = SupervisorEventStream({
  id: STREAM_OF["slow-op"],
  label: "Slow-op reports",
  icon: parseSavedSymbolName("speed"),
  description: "Stalls, slow interactions and blown budgets",
  kinds: () => kindsOf("slow-op"),
});

/**
 * Send one recorded report to its category's stream: one event per
 * occurrence, keyed by the report (its occurrences fold into one line).
 */
export const reportEventJob = defineJob({
  name: "supervisor-events.report",
  description:
    "Sends a recorded report to the supervisor its category's event stream is routed to.",
  hold: "seconds",
  input: z.object({ reportId: z.string() }),
  event: z.never(),
  dedup: "none",
  run: async ({ input }) => {
    const [row] = await db
      .select({
        id: _reports.id,
        kind: _reports.kind,
        message: _reports.message,
      })
      .from(_reports)
      .where(eq(_reports.id, reportIdKind.key(input.reportId)));
    if (!row) return; // deleted since (retention): nothing to tell
    const spec = ReportKind.getContributions().find((k) => k.kind === row.kind);
    if (!spec) throw new Error(`No report kind "${row.kind}" is registered.`);
    await publishSupervisorEvent({
      stream: STREAM_OF[spec.meta.category],
      key: row.id,
      kind: row.kind,
      title: row.message,
      ref: row.id,
    });
  },
});

export const reportRecordedToStreams = ReportRecorded({
  id: "tasks.supervisor-roles.events.report-streams",
  onRecorded: (reportId) => void reportEventJob.enqueue({ reportId }),
});
