import type { Report } from "@plugins/reports/core";
import { StepRegressionPayloadSchema, stepRegressionLine } from "../../core";

// One-line summary for the Debug → Reports list, e.g.
// "artifacts:detect took 157 s, its baseline 1.6 s (×98.7, 11 builds)".
export function StepRegressionSummary({ report }: { report: Report }) {
  const parsed = StepRegressionPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  return <>{stepRegressionLine(parsed.data)}</>;
}
