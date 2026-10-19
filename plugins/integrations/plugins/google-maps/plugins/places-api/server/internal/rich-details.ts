import {
  PlaceRichDetailsSchema,
  skuFor,
  type PlaceRichDetails,
  type PlacesClient,
} from "../../core";
import { PLACE_RICH_DETAILS_FIELD_MASK } from "./field-mask";
import { PLACES_BASE, placesFetch } from "./request";
import { priceLevel } from "./price-level";
import { openingHours, type OpeningHoursResponse } from "./opening-hours";

/** At most this many photos are kept: a card shows a strip, not an album. */
const MAX_PHOTOS = 10;

/** Raw `places.get` response, limited to `PLACE_RICH_DETAILS_FIELD_MASK`. */
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
 * The richer details of one place (see `PLACE_RICH_DETAILS_FIELD_MASK` for
 * what they cost). Billed on its own — no session: it is never part of a
 * search. Validated against `PlaceRichDetailsSchema`, so a malformed answer
 * throws rather than drawing a half-true card.
 */
export async function placeRichDetails(
  client: PlacesClient,
  placeId: string,
): Promise<PlaceRichDetails> {
  const url = new URL(`${PLACES_BASE}/places/${encodeURIComponent(placeId)}`);
  const body = await placesFetch<PlaceRichDetailsResponse>(url, client, {
    method: "GET",
    sku: skuFor("place-details", PLACE_RICH_DETAILS_FIELD_MASK),
    fieldMask: PLACE_RICH_DETAILS_FIELD_MASK,
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
