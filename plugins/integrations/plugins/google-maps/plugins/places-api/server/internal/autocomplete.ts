import {
  PlaceSuggestionSchema,
  type PlaceSuggestion,
  type PlacesClient,
} from "../../core";
import { PLACES_BASE, placesFetch } from "./request";

/** Raw `places:autocomplete` response. A field mask is optional on this call. */
interface AutocompleteResponse {
  suggestions?: {
    /** Present for a place hit; absent for a `queryPrediction` ("pizza near me"). */
    placePrediction?: {
      placeId: string;
      text?: { text?: string };
      structuredFormat?: {
        mainText?: { text?: string };
        secondaryText?: { text?: string };
      };
    };
  }[];
}

/**
 * Search places matching `input`.
 *
 * `sessionToken` groups this call with the `placeDetails` call that follows the
 * user's selection, so Google bills the pair as ONE autocomplete session. Mint
 * one per search-to-selection round and drop it after resolving.
 *
 * An empty array means Google found nothing — it is never a swallowed failure.
 * Anything that goes wrong throws `PlacesApiError`.
 */
export async function autocomplete(
  client: PlacesClient,
  input: string,
  sessionToken: string,
): Promise<PlaceSuggestion[]> {
  const body = await placesFetch<AutocompleteResponse>(
    new URL(`${PLACES_BASE}/places:autocomplete`),
    client,
    { method: "POST", sku: "autocomplete", body: { input, sessionToken } },
  );

  const out: PlaceSuggestion[] = [];
  for (const suggestion of body.suggestions ?? []) {
    const prediction = suggestion.placePrediction;
    // Query predictions carry no placeId, so there is nothing to resolve later.
    if (!prediction) continue;
    out.push(
      PlaceSuggestionSchema.parse({
        placeId: prediction.placeId,
        primary:
          prediction.structuredFormat?.mainText?.text ?? prediction.text?.text,
        secondary: prediction.structuredFormat?.secondaryText?.text,
      }),
    );
  }
  return out;
}
