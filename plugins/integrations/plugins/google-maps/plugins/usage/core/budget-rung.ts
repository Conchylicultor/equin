import type { PlacesSku } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";

/** One paid step of a downgrade ladder: the rung, and the SKU a call at it is billed as. */
export interface BudgetStep<R> {
  rung: R;
  sku: PlacesSku;
}

/**
 * A downgrade ladder's rung for this month: the first (richest) step whose SKU
 * is still within budget, else `floor` — the step that costs nothing (or calls
 * nothing), so a caller always has an answer inside Google's free allowance.
 */
export function budgetRung<R>(
  ladder: readonly BudgetStep<R>[],
  floor: R,
  withinBudget: (sku: PlacesSku) => boolean,
): R {
  for (const step of ladder) if (withinBudget(step.sku)) return step.rung;
  return floor;
}
