import type { Report } from "@plugins/reports/core";
import { BuildFailedPayloadSchema, buildFailedMessage } from "../../core";

// One-line summary for Debug → Reports, e.g.
// "main build failed in checks: type-check".
export function BuildFailedSummary({ report }: { report: Report }) {
  const parsed = BuildFailedPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  return <>{buildFailedMessage(parsed.data)}</>;
}
