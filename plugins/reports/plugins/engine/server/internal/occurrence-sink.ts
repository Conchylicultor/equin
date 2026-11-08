import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";
import type { ReportId } from "@plugins/reports/core";

/** One occurrence of a report whose fix is pending or live, to judge. */
export interface FixedReportOccurrence {
  reportId: ReportId;
  /** The fix it is judged against: the report's newest, unregressed. */
  fixCommit: string;
  /** Whether that fix is live (the report reads `fixed`). */
  deployed: boolean;
  /** The commit the occurrence's code ran; null when it could not name one. */
  commit: string | null;
  at: Date;
}

/**
 * An occurrence `recordReport` wrote for a report with a pending or live fix:
 * whether it regresses the fix is judged by the engine's own handler
 * (`fix-regression.ts`, a `sinkHandlers` entry), off the recording path — a
 * caller filing a report (a resource loader, a job) neither waits on nor
 * depends on that judgement, which reads git and the fix ledger.
 */
export const fixedReportOccurrenceSink =
  defineReportSink<FixedReportOccurrence>();
