import {
  richDetailsSku,
  type PlacesSku,
  type RichDetailsTier,
} from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import { budgetRung } from "@plugins/integrations/plugins/google-maps/plugins/usage/core";

// Each step's SKU is derived from its tier's field mask, so a field added to
// a mask moves the step's budget with it.
const DETAILS_LADDER = (["full", "no-summary"] as const).map((tier) => ({
  rung: tier,
  sku: richDetailsSku(tier),
}));

/**
 * The place card's downgrade ladder: everything with Google's summary while
 * the Enterprise + Atmosphere budget lasts, then without the summary
 * (Enterprise), then the photos alone (IDs Only, free) — so opening cards
 * stays inside Google's free allowance.
 */
export function detailsTier(
  withinBudget: (sku: PlacesSku) => boolean,
): RichDetailsTier {
  return budgetRung<RichDetailsTier>(DETAILS_LADDER, "photos", withinBudget);
}
