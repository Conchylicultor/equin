import { getPlacesClient } from "@plugins/integrations/plugins/google-maps/server";
import type { PlacesClient } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import {
  autocomplete,
  placeDetails,
} from "@plugins/integrations/plugins/google-maps/plugins/places-api/server";
import { definePlaceProvider } from "@plugins/page/plugins/place/server";
import type {
  PlaceSnapshot,
  PlaceSuggestion,
} from "@plugins/page/plugins/place/core";
import { GOOGLE_PLACE_PROVIDER_ID } from "../../shared";
import { recordReport } from "@plugins/reports/server";
import { googleTypeToKind } from "./type-to-kind";
import { googleTypeToFamily } from "./type-to-family";
import { PLACE_GOOGLE_UNKNOWN_TYPE } from "./unknown-type-kind";

/**
 * The Places client, or a loud stop.
 *
 * The registry's contract is that a provider which CANNOT answer throws, and
 * only a provider that genuinely found nothing returns an empty list. "No key
 * configured" is the first kind: returning `[]` here would render as "no
 * results for that address", which is a lie the user cannot debug.
 */
async function requireClient(): Promise<PlacesClient> {
  const maps = await getPlacesClient();
  if (!maps.ok) {
    throw new Error(
      "Google Maps is not set up: no API key configured. Add one under Settings → Accounts → Google Maps Platform.",
    );
  }
  return maps.client;
}

/**
 * The Google half of the place block, and the whole of it: this file is the
 * only place where "a place lookup" and "the Places API" meet.
 *
 * Both sides of the mapping below are structurally identical today, so the
 * field-by-field copies look redundant — they are the seam on purpose. The
 * place block owns the vocabulary a page stores; the Places client owns what
 * Google returns. Writing the copy out means a change on either side surfaces
 * here as a type error rather than silently reshaping stored block data.
 */
export const googlePlaceProvider = definePlaceProvider({
  id: GOOGLE_PLACE_PROVIDER_ID,

  async search(query: string, session: string): Promise<PlaceSuggestion[]> {
    const suggestions = await autocomplete(
      await requireClient(),
      query,
      session,
    );
    return suggestions.map((s) => ({
      placeId: s.placeId,
      primary: s.primary,
      secondary: s.secondary,
    }));
  },

  async resolve(placeId: string, session: string): Promise<PlaceSnapshot> {
    const place = await placeDetails(await requireClient(), placeId, session);
    const { family, unknownPrimary } = googleTypeToFamily(
      place.primaryType,
      place.types,
    );
    if (unknownPrimary !== undefined) {
      // Not a throw: a type Google added since the copy was made must not stop
      // the place resolving. The card paints neutral; the report says why.
      await recordReport({
        kind: PLACE_GOOGLE_UNKNOWN_TYPE,
        source: "server-place-google",
        data: { primaryType: unknownPrimary, placeName: place.name },
      });
    }
    return {
      placeId: place.placeId,
      name: place.name,
      address: place.address,
      category: place.category,
      // Google's taxonomy stops here: the block stores only the neutral kind
      // and family.
      kind: googleTypeToKind(place.primaryType, place.types),
      family,
      mapsUrl: place.mapsUrl,
      lat: place.lat,
      lng: place.lng,
    };
  },
});
