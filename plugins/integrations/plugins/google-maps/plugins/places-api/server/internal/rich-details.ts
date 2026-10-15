import { PlaceRichDetailsSchema, type PlaceRichDetails } from "../../core";
import { PLACE_RICH_DETAILS_FIELD_MASK } from "./field-mask";
import { PLACES_BASE, placesFetch } from "./request";

/** At most this many photos are kept: a card shows a strip, not an album. */
const MAX_PHOTOS = 10;

const PRICE_LEVELS: Record<string, number> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

type Point = { day?: number; hour?: number; minute?: number };

/** Raw `places.get` response, limited to `PLACE_RICH_DETAILS_FIELD_MASK`. */
interface PlaceRichDetailsResponse {
  photos?: {
    name?: string;
    widthPx?: number;
    heightPx?: number;
    authorAttributions?: { displayName?: string; uri?: string }[];
  }[];
  regularOpeningHours?: {
    periods?: { open?: Point; close?: Point }[];
    weekdayDescriptions?: string[];
  };
  utcOffsetMinutes?: number;
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  editorialSummary?: { text?: string };
}

// Google drops zero-valued fields of a point (`hour: 0` is absent).
const point = (p: Point) => ({
  day: p.day ?? 0,
  hour: p.hour ?? 0,
  minute: p.minute ?? 0,
});

/**
 * The richer details of one place (see `PLACE_RICH_DETAILS_FIELD_MASK` for
 * what they cost). Billed on its own — no session: it is never part of a
 * search. Validated against `PlaceRichDetailsSchema`, so a malformed answer
 * throws rather than drawing a half-true card.
 */
export async function placeRichDetails(
  apiKey: string,
  placeId: string,
): Promise<PlaceRichDetails> {
  const url = new URL(`${PLACES_BASE}/places/${encodeURIComponent(placeId)}`);
  const body = await placesFetch<PlaceRichDetailsResponse>(url, {
    method: "GET",
    apiKey,
    fieldMask: PLACE_RICH_DETAILS_FIELD_MASK,
  });
  const hours = body.regularOpeningHours;
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
    hours:
      hours === undefined
        ? undefined
        : {
            periods: (hours.periods ?? []).map((p) => ({
              open: point(p.open ?? {}),
              close: p.close === undefined ? undefined : point(p.close),
            })),
            weekdayDescriptions: hours.weekdayDescriptions ?? [],
          },
    utcOffsetMinutes: body.utcOffsetMinutes,
    rating: body.rating,
    ratingCount: body.userRatingCount,
    priceLevel:
      body.priceLevel === undefined ? undefined : PRICE_LEVELS[body.priceLevel],
    phone: body.internationalPhoneNumber,
    website: body.websiteUri,
    summary: body.editorialSummary?.text,
  });
}
