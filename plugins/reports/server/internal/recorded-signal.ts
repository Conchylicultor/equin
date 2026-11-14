import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";

/**
 * A listener on "a report row that nobody has investigated yet was written":
 * new, or an existing fingerprint recurring. Called on the hot path after the
 * row lands (past the duress and fan-out gates — a collapsed storm never
 * calls), so `onRecorded` must be cheap: wake something, enqueue a job. Noise
 * reports and reports already linked to a task do not call. Any number of
 * plugins may listen (the Report investigations automation, supervisor event
 * streams); each contributes one.
 */
export interface ReportRecordedListener {
  id: string;
  onRecorded(reportId: string): void;
}

export const ReportRecorded = defineServerContribution<ReportRecordedListener>(
  "report-recorded",
  {
    docLabel: (l) => l.id,
    absentOnHost: {
      reason:
        "called where reports are written (`reports/engine`, desktop-only): a host without the engine records no report, so nothing would call its listeners",
    },
  },
);
