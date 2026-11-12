import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";

// Facts only. A rule never sees a report's words (message, errorType,
// stack): matching them is how real bugs got muted (the "ResizeObserver loop"
// warning, a Claude Code exit code), so it has no spelling.
export interface ReportNoiseInput {
  source: string;
  // True when version skew explains the report: every occurrence PROVED it,
  // by the proof its source declares (reports/core's SKEW_PROOF /
  // versionSkewExplains) — a failed load by a 404 file of the tab's build the
  // server confirmed retired, another build's stored entry by the tab being
  // outdated. Never for a bug in the tab's own code, what it saw the server
  // do, or a load whose files are all still served.
  versionSkew: boolean;
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
