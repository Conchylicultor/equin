import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";

export interface ReportNoiseInput {
  source: string;
  errorType: string | null;
  message: string;
  stack: string | null;
  // True when the report's build id differs from the server's current build id
  // (the crash came from an outdated frontend tab — benign version-skew).
  staleOrigin?: boolean;
}
export interface ReportNoiseRuleSpec {
  id: string;
  matches: (input: ReportNoiseInput) => boolean;
}

// The slot. The engine (`reports/plugins/engine`) evaluates it on every report
// and on the boot noise backfill.
export const ReportNoiseRule = defineServerContribution<ReportNoiseRuleSpec>(
  "report-noise-rule",
  { docLabel: (r) => r.id },
);
