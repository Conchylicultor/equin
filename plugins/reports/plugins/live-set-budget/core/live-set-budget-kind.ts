import { z } from "zod";

/** The report kind a whole live set past its declared budget files. */
export const LIVE_SET_OVER_BUDGET_KIND = "live-set-over-budget";

// The payload, stored in the generic `data` jsonb column and validated on
// ingest by the kind: one load of a whole set (`all: { unbounded: { reason,
// budget } }`) that read more rows than its budget — the network/live
// `liveSetOverBudgetSink` body.
export const LiveSetOverBudgetPayloadSchema = z.object({
  // The set's live-resource key.
  key: z.string(),
  // The tuple that loaded past the budget (`{}` unscoped, else its scope).
  params: z.record(z.string(), z.string()),
  // Rows the load read, and the declared budget it passed.
  rows: z.number().int(),
  budget: z.number().int(),
  // The declaration's reason the set stays small — the claim now false.
  reason: z.string(),
});
export type LiveSetOverBudgetPayload = z.infer<
  typeof LiveSetOverBudgetPayloadSchema
>;

// One declaration is one claim: one row per key, whichever tuple outgrew it.
export function liveSetOverBudgetFingerprint(
  data: LiveSetOverBudgetPayload,
): string {
  return `${LIVE_SET_OVER_BUDGET_KIND}:${data.key}`;
}
