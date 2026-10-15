import { PlaceCandidateSchema, type PlaceCandidate } from "../../core";
import { PLACES_BASE, placesFetch } from "./request";

/**
 * The Text Search field mask — like Place Details', REQUIRED and a cost decision.
 *
 * Text Search (New) is billed by the highest tier among the requested fields:
 * `places.id` alone is the free "Text Search Essentials (IDs Only)" SKU, but
 * every other field here — `displayName`, `location`, `types`,
 * `formattedAddress`, `viewport`, `businessStatus` — is a **Text Search Pro**
 * field (one tier: once one is asked for, the rest cost nothing more). Nothing
 * from the Enterprise tier (rating, opening hours, phone). They are kept on
 * purpose: a caller deciding whether a hit is the place it
 * meant (the Mapstr import: within 150 m, similar name) needs them, and fetching
 * them instead through `placeDetails` per candidate would cost a Pro call per
 * candidate rather than one per search. Re-check Google's SKU table before
 * relying on this (it has been re-cut more than once).
 */
export const SEARCH_TEXT_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.location",
  "places.types",
  "places.formattedAddress",
  "places.viewport",
  "places.businessStatus",
].join(",");

/** Prefer hits within `radiusM` of a point (a bias, not a filter). */
export interface SearchTextBias {
  lat: number;
  lng: number;
  radiusM: number;
}

export interface SearchTextOptions {
  bias?: SearchTextBias;
  /** At most this many hits (Google's `pageSize`); 5 when omitted. */
  maxResults?: number;
  /**
   * The language Google names the hits in (BCP-47, "fr", "de"). Without it,
   * Google often answers in English ("Musée Bourdelle" → "Bourdelle Museum").
   */
  languageCode?: string;
}

/** Raw `places:searchText` response, limited to `SEARCH_TEXT_FIELD_MASK`. */
interface SearchTextResponse {
  places?: {
    id?: string;
    displayName?: { text?: string };
    location?: { latitude?: number; longitude?: number };
    types?: string[];
    formattedAddress?: string;
    businessStatus?: string;
    viewport?: {
      low?: { latitude?: number; longitude?: number };
      high?: { latitude?: number; longitude?: number };
    };
  }[];
}

/**
 * Free-text place search (`POST /v1/places:searchText`): Google's best hits for
 * `query` ("<name>, <address>"), at most `maxResults`, biased toward `bias`,
 * named in `languageCode`.
 *
 * An empty array means Google found nothing — never a swallowed failure. A hit
 * missing its name or location throws (ZodError) rather than producing a
 * candidate nobody can judge; so does a viewport missing a corner. Anything else that goes wrong throws
 * `PlacesApiError`.
 */
export async function searchText(
  apiKey: string,
  query: string,
  { bias, maxResults = 5, languageCode }: SearchTextOptions = {},
): Promise<PlaceCandidate[]> {
  const body = await placesFetch<SearchTextResponse>(
    new URL(`${PLACES_BASE}/places:searchText`),
    {
      method: "POST",
      apiKey,
      fieldMask: SEARCH_TEXT_FIELD_MASK,
      body: {
        textQuery: query,
        pageSize: maxResults,
        ...(languageCode === undefined ? {} : { languageCode }),
        ...(bias === undefined
          ? {}
          : {
              locationBias: {
                circle: {
                  center: { latitude: bias.lat, longitude: bias.lng },
                  radius: bias.radiusM,
                },
              },
            }),
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
    }),
  );
}
