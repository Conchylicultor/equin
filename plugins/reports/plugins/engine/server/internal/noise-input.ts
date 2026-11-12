import type {
  ReportNoiseInput,
  ReportNoiseRuleSpec,
} from "@plugins/reports/server";

// How a report is classified, minus the rules themselves: what a rule is asked
// about (built from a report — the one mapping both classifiers use:
// `recordReport` for a fresh occurrence and the reconcile for a stored row) and
// how the rules' answers combine. A leaf that imports nothing but types: the
// reconcile stamps the stored flags with this module's code digest beside the
// rules', so a change here re-runs it.

/**
 * What a rule is asked about a report: its facts, never its words (a rule
 * cannot match text — reports/server's ReportNoiseInput).
 */
export function noiseInputOf(report: {
  source: string;
  /** reports/core's `versionSkewMayExplain` of the report — judged by the caller, so this leaf stays type-only. */
  versionSkew: boolean;
}): ReportNoiseInput {
  return { source: report.source, versionSkew: report.versionSkew };
}

/** Noise when any rule matches; a rule that throws is a non-match. */
export function matchesAnyRule(
  rules: readonly ReportNoiseRuleSpec[],
  input: ReportNoiseInput,
): boolean {
  return rules.some((rule) => {
    try {
      return rule.matches(input);
      // eslint-disable-next-line promise-safety/no-bare-catch, promise-safety/no-absorbed-failure -- this runs inside the report pipeline itself; propagating any error here would break report recording, which is worse than swallowing a buggy noise-rule match
    } catch {
      return false; // a buggy rule must never break the report pipeline (itself the error path)
    }
  });
}

/** This module, for the reconcile's code digest. */
export const noiseInputCode = import.meta;
