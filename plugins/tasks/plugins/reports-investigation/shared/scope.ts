import { z } from "zod";

/** Which report kinds qualify by severity: the kind's bell variant. */
export const REPORT_SEVERITIES = ["error", "warning", "everything"] as const;
export type ReportSeverityScope = (typeof REPORT_SEVERITIES)[number];
export const REPORT_SEVERITY_LABELS: Record<ReportSeverityScope, string> = {
  error: "Errors",
  warning: "Errors & warnings",
  everything: "Everything",
};

/** Whether a kind whose bell variant is `variant` is in a severity scope. */
export function severityInScope(
  variant: string,
  scope: ReportSeverityScope,
): boolean {
  switch (scope) {
    case "error":
      return variant === "error";
    case "warning":
      return variant === "error" || variant === "warning";
    case "everything":
      return true;
  }
}

/** One report kind as the scope section lists it. */
export const ReportKindScopeSchema = z.object({
  kind: z.string(),
  /** The kind's bell variant (error | warning | info | success). */
  variant: z.string(),
  /** Uninvestigated reports of this kind with at least `minCount` occurrences. */
  open: z.number().int(),
});
export type ReportKindScope = z.infer<typeof ReportKindScopeSchema>;

/** At most this many reports go into one investigation task; the rest wait. */
export const MAX_REPORTS_PER_TASK = 20;

/**
 * The default prompt template of an investigation task — what the build
 * commits as the Report investigations config's `prompt`.
 */
export const REPORT_INVESTIGATIONS_PROMPT = `These reports were filed and nobody has investigated them yet. They arrived together, so they may share one root cause — check that first.

{{reports}}

Before debugging, read the \`debug\` skill (\`.claude/skills/debug/SKILL.md\`) — the map of logs, profiling, slow-ops, crashes and DB surfaces.

1. Find the root cause. Reproduce it if you can, and quote the evidence (log lines, trace, query) that pins it.
2. Fix the cause, not the symptom — take the highest rung of the fix ladder in CLAUDE.md.
3. Run \`./equin build\` and confirm the reports stop recurring.
4. If you cannot find or fix the cause, write up what you learned and raise a flag.

{{pushPolicy}}`;
