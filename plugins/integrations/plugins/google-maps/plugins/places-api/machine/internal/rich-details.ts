import {
  PlaceRichDetailsSchema,
  RICH_DETAILS_MASKS,
  richDetailsSku,
  type PlaceRichDetails,
  type PlacesClient,
  type RichDetailsTier,
} from "../../core";
import { PLACES_BASE, placesFetch } from "./request";
import { priceLevel } from "./price-level";
import { openingHours, type OpeningHoursResponse } from "./opening-hours";

/** At most this many photos are kept: a card shows a strip, not an album. */
const MAX_PHOTOS = 10;

/** Raw `places.get` response, limited to a `RICH_DETAILS_MASKS` mask. */
interface PlaceRichDetailsResponse {
  photos?: {
    name?: string;
    widthPx?: number;
    heightPx?: number;
    authorAttributions?: { displayName?: string; uri?: string }[];
  }[];
  regularOpeningHours?: OpeningHoursResponse;
  utcOffsetMinutes?: number;
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  editorialSummary?: { text?: string };
}

/**
 * The richer details of one place, at `tier` (`RICH_DETAILS_TIERS` says what
 * each asks for and costs). The tier is required: a call cannot default to the
 * most expensive one. Billed on its own — no session: it is never part of a
 * search. A field the tier does not ask for is absent. Validated against `PlaceRichDetailsSchema`, so a malformed answer
 * throws rather than drawing a half-true card.
 */
export async function placeRichDetails(
  client: PlacesClient,
  placeId: string,
  tier: RichDetailsTier,
): Promise<PlaceRichDetails> {
  const url = new URL(`${PLACES_BASE}/places/${encodeURIComponent(placeId)}`);
  const body = await placesFetch<PlaceRichDetailsResponse>(url, client, {
    method: "GET",
    sku: richDetailsSku(tier),
    fieldMask: RICH_DETAILS_MASKS[tier],
  });
  return PlaceRichDetailsSchema.parse({
    photos: (body.photos ?? []).slice(0, MAX_PHOTOS).map((p) => ({
      name: p.name,
      widthPx: p.widthPx,
      heightPx: p.heightPx,
      authors: (p.authorAttributions ?? []).map((a) => ({
        name: a.displayName,
        uri: a.uri,
      })),
    })),
    hours: openingHours(body.regularOpeningHours),
    utcOffsetMinutes: body.utcOffsetMinutes,
    rating: body.rating,
    ratingCount: body.userRatingCount,
    priceLevel: priceLevel(body.priceLevel),
    phone: body.internationalPhoneNumber,
    website: body.websiteUri,
    summary: body.editorialSummary?.text,
  });
}
