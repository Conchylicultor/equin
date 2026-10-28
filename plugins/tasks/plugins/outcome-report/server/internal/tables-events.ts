import { text } from "drizzle-orm/pg-core";
import { defineTriggerEvent } from "@plugins/infra/plugins/events/server";
import type { ReportStanding } from "../../core";

export interface OutcomeReportSubmittedPayload {
  taskId: string;
  conversationId: string;
  standing: ReportStanding;
  /** The report itself (markdown). */
  body: string;
  /** The one decision it asks the user for; null when it asks none. */
  question: string | null;
  [key: string]: unknown;
}

// Emitted by `submit_outcome_report` right after the report row is written —
// whoever cares that a report landed (a watcher, an automation's slot)
// subscribes, rather than the tool naming them. Filterable by taskId.
export const {
  event: outcomeReportSubmitted,
  table: _outcomeReportSubmittedTriggers,
} = defineTriggerEvent<OutcomeReportSubmittedPayload>({
  name: "outcomeReport.submitted",
  filters: {
    taskId: text("task_id"),
  },
});
