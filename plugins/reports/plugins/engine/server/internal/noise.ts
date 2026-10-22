import {
  ReportNoiseRule,
  type ReportNoiseInput,
} from "@plugins/reports/server";

// collectContributions() runs at boot, before any handler — getContributions() is populated
// by the time recordReport runs (HTTP handler, onReady flush, or error reporter).
export function isNoiseReport(input: ReportNoiseInput): boolean {
  return ReportNoiseRule.getContributions().some((rule) => {
    try {
      return rule.matches(input);
      // eslint-disable-next-line promise-safety/no-bare-catch, promise-safety/no-absorbed-failure -- this runs inside the report pipeline itself; propagating any error here would break report recording, which is worse than swallowing a buggy noise-rule match
    } catch {
      return false; // a buggy rule must never break the report pipeline (itself the error path)
    }
  });
}
