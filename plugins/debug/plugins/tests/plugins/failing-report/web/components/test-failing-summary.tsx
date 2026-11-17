import type { Report } from "@plugins/reports/core";
import { TestFailingPayloadSchema, testFailingMessage } from "../../core";

// One-line summary for Debug → Reports, e.g.
// "test plugins/x/y.test.ts fails (2 cases) on main — passed at abc, failing since def".
export function TestFailingSummary({ report }: { report: Report }) {
  const parsed = TestFailingPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  return <>{testFailingMessage(parsed.data)}</>;
}
