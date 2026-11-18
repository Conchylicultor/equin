import type { Report } from "@plugins/reports/core";
import { CheckPassHungPayloadSchema, checkPassHungMessage } from "../../core";

// One-line summary for the Debug → Reports list — the row's message, derived
// from the payload like `CheckThreadStallSummary`.
export function CheckPassHungSummary({ report }: { report: Report }) {
  const parsed = CheckPassHungPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  return <>{checkPassHungMessage(parsed.data)}</>;
}
