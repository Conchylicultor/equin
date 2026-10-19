import {
  PlaceCandidateSchema,
  skuFor,
  type PlaceCandidate,
  type PlacesClient,
} from "../../core";
import { openingHours, type OpeningHoursResponse } from "./opening-hours";
import { priceLevel } from "./price-level";
import { PLACES_BASE, placesFetch } from "./request";

/**
 * The Text Search field masks — like Place Details', REQUIRED and a cost
 * decision; `skuFor` derives what each is billed as.
 *
 * `pro` (**Text Search Pro**): `places.id` alone would be the free IDs-only
 * SKU, but a caller deciding whether a hit is the place it meant (the Mapstr
 * import: within 150 m, similar name) needs the name, position, types and
 * address — and every field here is one tier, so the type's display name rides
 * along for nothing. Fetching them instead through `placeDetails` per
 * candidate would cost a Pro call per candidate rather than one per search.
 *
 * `rich` (**Text Search Enterprise**): `pro` plus what a result card shows —
 * rating and its count, price level, this week's hours and the place's UTC
 * offset to read them in. Nothing from Atmosphere (no summary, no reviews).
 */
export const SEARCH_TEXT_FIELD_MASKS = {
  pro: [
    "places.id",
    "places.displayName",
    "places.location",
    "places.types",
    "places.formattedAddress",
    "places.viewport",
    "places.businessStatus",
    "places.primaryType",
    "places.primaryTypeDisplayName",
  ].join(","),
  rich: [
    "places.id",
    "places.displayName",
    "places.location",
    "places.types",
    "places.formattedAddress",
    "places.viewport",
    "places.businessStatus",
    "places.primaryType",
    "places.primaryTypeDisplayName",
    "places.rating",
    "places.userRatingCount",
    "places.priceLevel",
    "places.currentOpeningHours",
    "places.utcOffsetMinutes",
  ].join(","),
} as const;

export type SearchTextDetail = keyof typeof SEARCH_TEXT_FIELD_MASKS;

type Corner = { lat: number; lng: number };

/**
 * Where to prefer hits (a bias, not a filter): within `radiusM` of a point, or
 * inside a box (the map's visible area).
 */
export type SearchTextBias =
  | { kind: "circle"; lat: number; lng: number; radiusM: number }
  | { kind: "rectangle"; low: Corner; high: Corner };

export interface SearchTextOptions {
  bias?: SearchTextBias;
  /** What each hit carries, and so what the call costs; `pro` when omitted. */
  detail?: SearchTextDetail;
  /** At most this many hits (Google's `pageSize`, ≤ 20); 5 when omitted. */
  maxResults?: number;
  /**
   * The language Google names the hits in (BCP-47, "fr", "de"). Without it,
   * Google often answers in English ("Musée Bourdelle" → "Bourdelle Museum").
   */
  languageCode?: string;
}

type WireCorner = { latitude?: number; longitude?: number };

/** Raw `places:searchText` response, limited to `SEARCH_TEXT_FIELD_MASKS`. */
interface SearchTextResponse {
  places?: {
    id?: string;
    displayName?: { text?: string };
    location?: WireCorner;
    types?: string[];
    formattedAddress?: string;
    businessStatus?: string;
    viewport?: { low?: WireCorner; high?: WireCorner };
    primaryType?: string;
    primaryTypeDisplayName?: { text?: string };
    rating?: number;
    userRatingCount?: number;
    priceLevel?: string;
    currentOpeningHours?: OpeningHoursResponse;
    utcOffsetMinutes?: number;
  }[];
}

const wireCorner = (c: Corner) => ({ latitude: c.lat, longitude: c.lng });

function locationBias(bias: SearchTextBias) {
  return bias.kind === "circle"
    ? {
        circle: {
          center: { latitude: bias.lat, longitude: bias.lng },
          radius: bias.radiusM,
        },
      }
    : {
        rectangle: { low: wireCorner(bias.low), high: wireCorner(bias.high) },
      };
}

/**
 * Free-text place search (`POST /v1/places:searchText`): Google's best hits for
 * `query`, at most `maxResults`, biased toward `bias`, named in `languageCode`,
 * each carrying what `detail` asks for.
 *
 * An empty array means Google found nothing — never a swallowed failure. A hit
 * missing its name or location throws (ZodError) rather than producing a
 * candidate nobody can judge; so does a viewport missing a corner. Anything
 * else that goes wrong throws `PlacesApiError`.
 */
export async function searchText(
  client: PlacesClient,
  query: string,
  {
    bias,
    detail = "pro",
    maxResults = 5,
    languageCode,
  }: SearchTextOptions = {},
): Promise<PlaceCandidate[]> {
  const fieldMask = SEARCH_TEXT_FIELD_MASKS[detail];
  const body = await placesFetch<SearchTextResponse>(
    new URL(`${PLACES_BASE}/places:searchText`),
    client,
    {
      method: "POST",
      sku: skuFor("text-search", fieldMask),
      fieldMask,
      body: {
        textQuery: query,
        pageSize: maxResults,
        ...(languageCode === undefined ? {} : { languageCode }),
        ...(bias === undefined ? {} : { locationBias: locationBias(bias) }),
      },
    },
  );

  return (body.places ?? []).map((place) =>
    PlaceCandidateSchema.parse({
      placeId: place.id,
      name: place.displayName?.text,
      lat: place.location?.latitude,
      lng: place.location?.longitude,
      types: place.types ?? [],
      address: place.formattedAddress,
      // Google's enum default ("unused", per its docs) says nothing: absent.
      businessStatus:
        place.businessStatus === "BUSINESS_STATUS_UNSPECIFIED"
          ? undefined
          : place.businessStatus,
      viewport:
        place.viewport === undefined
          ? undefined
          : {
              low: {
                lat: place.viewport.low?.latitude,
                lng: place.viewport.low?.longitude,
              },
              high: {
                lat: place.viewport.high?.latitude,
                lng: place.viewport.high?.longitude,
              },
            },
      category: place.primaryTypeDisplayName?.text,
      primaryType: place.primaryType,
      rating: place.rating,
      ratingCount: place.userRatingCount,
      priceLevel: priceLevel(place.priceLevel),
      hours: openingHours(place.currentOpeningHours),
      utcOffsetMinutes: place.utcOffsetMinutes,
    }),
  );
}
