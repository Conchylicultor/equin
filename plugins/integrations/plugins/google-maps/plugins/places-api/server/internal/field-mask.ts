/**
 * The Place Details field mask — REQUIRED by the Places API (New); omitting it
 * is an error, not a default.
 *
 * **This is a cost decision, which is why it is one named constant.** Google
 * prices Place Details by the most expensive tier any requested field belongs
 * to:
 *
 * - `id`                                        — IDs Only (free)
 * - `formattedAddress`, `location`, `types`     — Essentials
 * - `displayName`, `googleMapsUri`,
 *   `primaryType`, `primaryTypeDisplayName`,
 *   `businessStatus`                            — Pro
 * - `rating`, `userRatingCount`,
 *   `regularOpeningHours`,
 *   `internationalPhoneNumber`,
 *   `editorialSummary`                          — Enterprise (~2x the per-call price)
 *
 * v1 requests Essentials + Pro ONLY. Adding a rating or opening hours to the
 * card later is a one-line change here with a known bill attached — make it
 * deliberately. Google has re-cut this pricing more than once; re-check the
 * current SKU table before relying on the tiers above.
 */
export const PLACE_DETAILS_FIELD_MASK = [
  "id",
  "displayName",
  "formattedAddress",
  "googleMapsUri",
  "primaryTypeDisplayName",
  "primaryType",
  "types",
  "location",
  // Pro, like displayName above: adding it does not raise the call's tier.
  "businessStatus",
].join(",");
