import type { Report } from "@plugins/reports/core";
import {
  InteractionBudgetPayloadSchema,
  interactionBudgetMessage,
} from "../../core";

// One-line summary for the Debug → Reports list, e.g. "Desktop ↔ full screen
// switch over budget: exit, 4 windows 21480 > 8000 elements restyled (a..b)".
export function InteractionBudgetSummary({ report }: { report: Report }) {
  const parsed = InteractionBudgetPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  return <>{interactionBudgetMessage(parsed.data)}</>;
}
