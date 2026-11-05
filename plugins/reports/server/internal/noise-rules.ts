import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";

export interface ReportNoiseInput {
  source: string;
  errorType: string | null;
  message: string;
  stack: string | null;
  // True when the report came from an outdated frontend tab and is about that
  // tab's own code — benign version-skew (reports/core's isStaleOrigin; a
  // report about what the tab saw the server do is never stale-origin).
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
