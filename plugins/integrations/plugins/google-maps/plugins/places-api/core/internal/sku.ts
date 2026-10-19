/**
 * What Google bills a Places call as — one SKU per (call family, tier). Google
 * prices a Place Details or Text Search call by the HIGHEST tier among the
 * fields its mask asks for, so the SKU of a call is derived from its mask
 * (`skuFor`), never written down beside it: a mask that grows a field grows its
 * SKU with it. Re-check Google's SKU table before relying on the tiers below
 * (it has been re-cut more than once).
 */
export const PLACES_SKUS = [
  "autocomplete",
  "place-details-ids",
  "place-details-essentials",
  "place-details-pro",
  "place-details-enterprise",
  "place-details-enterprise-atmosphere",
  "text-search-ids",
  "text-search-pro",
  "text-search-enterprise",
  "text-search-enterprise-atmosphere",
  "place-photo",
] as const;

export type PlacesSku = (typeof PLACES_SKUS)[number];

/** Field tiers, cheapest first. */
const TIERS = ["ids", "essentials", "pro", "enterprise", "atmosphere"] as const;
type Tier = (typeof TIERS)[number];

/**
 * The tier of every field a mask here may name (Place Details spelling; Text
 * Search prefixes each with `places.`). A field not listed throws in
 * `skuFor`: adding one to a mask means placing it here, with its price.
 */
const FIELD_TIER: Record<string, Tier> = {
  id: "ids",
  name: "ids",
  photos: "ids",
  attributions: "ids",
  formattedAddress: "essentials",
  location: "essentials",
  types: "essentials",
  viewport: "essentials",
  displayName: "pro",
  googleMapsUri: "pro",
  primaryType: "pro",
  primaryTypeDisplayName: "pro",
  businessStatus: "pro",
  utcOffsetMinutes: "pro",
  rating: "enterprise",
  userRatingCount: "enterprise",
  priceLevel: "enterprise",
  regularOpeningHours: "enterprise",
  currentOpeningHours: "enterprise",
  internationalPhoneNumber: "enterprise",
  websiteUri: "enterprise",
  editorialSummary: "atmosphere",
};

export type MaskedCall = "place-details" | "text-search";

/**
 * The SKU a masked call is billed as: the highest tier among its fields. Text
 * Search has no Essentials SKU — an Essentials field lifts it to Pro.
 */
export function skuFor(call: MaskedCall, fieldMask: string): PlacesSku {
  let top = 0;
  for (const raw of fieldMask.split(",")) {
    const field = call === "text-search" ? raw.replace(/^places\./, "") : raw;
    // A sub-field (`currentOpeningHours.openNow`) is billed as its parent.
    const tier = FIELD_TIER[field.split(".")[0] ?? field];
    if (tier === undefined) {
      throw new Error(`No known Places billing tier for field "${raw}"`);
    }
    top = Math.max(top, TIERS.indexOf(tier));
  }
  const tier = TIERS[top] ?? "ids";
  if (call === "place-details") {
    return tier === "atmosphere"
      ? "place-details-enterprise-atmosphere"
      : `place-details-${tier}`;
  }
  if (tier === "essentials") return "text-search-pro";
  return tier === "atmosphere"
    ? "text-search-enterprise-atmosphere"
    : `text-search-${tier}`;
}

/**
 * Where a client's calls are counted. Recording happens BEFORE each request (a
 * refused call may still be billed): an over-count is a margin, an
 * under-count is a bill. A recorder that fails fails the call.
 */
export interface PlacesMeter {
  record(sku: PlacesSku): Promise<void>;
}

/**
 * What every Places call takes: the key, and the meter its calls are counted
 * on. One value, so a call cannot be made without being counted.
 */
export interface PlacesClient {
  readonly apiKey: string;
  readonly meter: PlacesMeter;
}
