import type { Report } from "@plugins/reports/core";
import { HostCheckPayloadSchema, hostCheckMessage } from "../../core";

// One-line summary for the Debug → Reports list, e.g.
// "host check paths:no-undeclared-data-dirs failed — 1 problem(s) under …".
export function HostCheckSummary({ report }: { report: Report }) {
  const parsed = HostCheckPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  return <>{hostCheckMessage(parsed.data)}</>;
}
