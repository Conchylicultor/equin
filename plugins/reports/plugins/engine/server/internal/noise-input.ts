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
 * The noise pipeline classifies on a small, generic shape. Crash-shaped fields
 * (errorType / stack) that noise rules inspect live in the kind's `data`
 * payload; surfaced here as plain strings if present. A kind that has no such
 * fields simply yields nulls and matches no crash-specific noise rule.
 */
export function noiseInputOf(report: {
  source: string;
  message: string;
  data: Record<string, unknown>;
  /** reports/core's `versionSkewMayExplain` of the report — judged by the caller, so this leaf stays type-only. */
  versionSkew: boolean;
}): ReportNoiseInput {
  const { data } = report;
  return {
    source: report.source,
    errorType: typeof data.errorType === "string" ? data.errorType : null,
    message: report.message,
    stack: typeof data.stack === "string" ? data.stack : null,
    versionSkew: report.versionSkew,
  };
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
