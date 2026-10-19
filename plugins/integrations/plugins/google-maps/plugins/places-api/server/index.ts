import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { autocomplete } from "./internal/autocomplete";
export { placeDetails } from "./internal/details";
export {
  searchText,
  type SearchTextBias,
  type SearchTextDetail,
  type SearchTextOptions,
} from "./internal/search-text";
export { placeRichDetails } from "./internal/rich-details";
export { placePhoto, placeFirstPhotoName } from "./internal/photo";
export {
  PLACE_DETAILS_FIELD_MASK,
  PLACE_RICH_DETAILS_FIELD_MASK,
} from "./internal/field-mask";

export default {
  description:
    "Stateless typed Google Places API (New) client: places:autocomplete, places:searchText (pro, or rich with rating, price and this week's hours; biased to a circle or a box), place details, the separately priced rich details (photos, hours, rating, phone, website, summary) and place photos, mapped to the neutral PlaceSuggestion / PlaceSnapshot / PlaceCandidate shapes. Every call takes a PlacesClient — the key and the meter it is counted on, its SKU derived from its field mask (skuFor) — and never touches auth or storage.",
  contributions: [],
} satisfies ServerPluginDefinition;
