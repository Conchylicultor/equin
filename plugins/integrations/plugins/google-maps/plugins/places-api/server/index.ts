import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { autocomplete } from "./internal/autocomplete";
export { placeDetails } from "./internal/details";
export {
  searchText,
  type SearchTextBias,
  type SearchTextOptions,
} from "./internal/search-text";
export { PLACE_DETAILS_FIELD_MASK } from "./internal/field-mask";

export default {
  description:
    "Stateless typed Google Places API (New) client: places:autocomplete, places:searchText and place details, mapped to the neutral PlaceSuggestion / PlaceSnapshot shapes. Takes the API key per call; never touches auth or storage.",
  contributions: [],
} satisfies ServerPluginDefinition;
