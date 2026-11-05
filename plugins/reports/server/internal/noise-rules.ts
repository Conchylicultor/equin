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
  /**
   * The module holding `matches` (`import.meta`) — what the stored `noise`
   * flags were computed by. The engine reclassifies the stored rows only when
   * the code of the rule set changes (its source digest), so keep the rule in
   * a small module that imports nothing but types: everything it loads counts.
   */
  code: ImportMeta;
}

// The slot. The engine (`reports/plugins/engine`) evaluates it on every report,
// and reclassifies the stored rows once whenever the rules' code changes.
export const ReportNoiseRule = defineServerContribution<ReportNoiseRuleSpec>(
  "report-noise-rule",
  { docLabel: (r) => r.id },
);
