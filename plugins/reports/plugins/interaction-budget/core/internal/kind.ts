import { z } from "zod";

/**
 * The report kind string, spelled once: the server registers its `ReportKind`
 * under it, the web dispatches its `Reports.KindView` on it, and a budget
 * script's `settleBudget` files under it.
 */
export const INTERACTION_BUDGET_KIND = "interaction-budget";

/** One measured case of a scenario (`enter, 4 windows`). */
export const BudgetCaseSchema = z.object({
  /** Stable id within the scenario (`enter-4w`). */
  id: z.string(),
  /** What a person reads (`enter full screen, 4 windows`). */
  label: z.string(),
  /** The value the verdict compares: the median of the measured samples. */
  measured: z.number(),
  budget: z.number(),
  /** Every sample the median was taken over, in run order. */
  samples: z.array(z.number()).max(64),
});
export type BudgetCase = z.infer<typeof BudgetCaseSchema>;

/**
 * One scenario run over budget: every case it measured (within budget or not,
 * so the row shows the whole picture), the deployed commit it measured, and the
 * last commit a run found within budget — the regression is in
 * `lastWithinBudget..commit`.
 */
export const InteractionBudgetPayloadSchema = z.object({
  /** Stable scenario id (`desktop.fullscreen-switch`) — the fingerprint. */
  scenario: z.string(),
  /** What the scenario is, in words (`Desktop ↔ full screen switch`). */
  title: z.string(),
  /** The unit every case is measured in (`elements restyled`). */
  metric: z.string(),
  cases: z.array(BudgetCaseSchema).max(32),
  /** The deployed commit this run measured. */
  commit: z.string(),
  /** The last commit a filing run found within budget; null before the first. */
  lastWithinBudget: z.string().nullable(),
  /** The command that reproduces the measurement. */
  rerun: z.string(),
  /** The scenario's own guidance: how to find the cause, what it usually is. */
  hint: z.string(),
});
export type InteractionBudgetPayload = z.infer<
  typeof InteractionBudgetPayloadSchema
>;

/** One row per scenario: each over-budget run bumps that scenario's count. */
export function interactionBudgetFingerprint(
  d: InteractionBudgetPayload,
): string {
  return `${INTERACTION_BUDGET_KIND}:${d.scenario}`;
}

/** The cases over budget. */
export function overBudget(cases: readonly BudgetCase[]): BudgetCase[] {
  return cases.filter((c) => c.measured > c.budget);
}

/** A short commit. */
export function shortCommit(sha: string): string {
  return sha.slice(0, 10);
}

/** `abc1234567..def8901234`, or `up to def8901234` before any run was within budget. */
export function budgetCommitRange(d: InteractionBudgetPayload): string {
  return d.lastWithinBudget === null
    ? `up to ${shortCommit(d.commit)}`
    : `${shortCommit(d.lastWithinBudget)}..${shortCommit(d.commit)}`;
}

/**
 * The one-line summary — the report row's `message`, and the KindView's text:
 * `Desktop ↔ full screen switch over budget: exit, 4 windows 21480 > 8000
 * elements restyled (abc..def)`.
 */
export function interactionBudgetMessage(d: InteractionBudgetPayload): string {
  const over = overBudget(d.cases)
    .map((c) => `${c.label} ${Math.round(c.measured)} > ${c.budget}`)
    .join(", ");
  return `${d.title} over budget: ${over} ${d.metric} (${budgetCommitRange(d)})`;
}
