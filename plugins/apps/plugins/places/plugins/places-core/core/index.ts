export { placeFields } from "./internal/fields";
export { placesEntityRef, placeTagsEntityRef } from "./internal/entity-refs";
export {
  PlaceSchema,
  type Place,
  PlaceTagSchema,
  type PlaceTag,
} from "./internal/schema";
export { placeName, isCustomPlace } from "./internal/place-name";
export { placeIdKind, placeTagIdKind } from "./internal/id-kinds";
export type { PlaceId, PlaceTagId } from "./internal/id-kinds";
export {
  places,
  placeTags,
  placeTagTree,
  placeSearch,
} from "./internal/resources";
export {
  MapsNotConfiguredSchema,
  PlaceBoundsSchema,
  type PlaceBounds,
  PlaceSearchQuerySchema,
  type PlaceSearchQuery,
  PlaceSearchResultSchema,
  type PlaceSearchResult,
  PLACES_SEARCH_MAX_RESULTS,
  PLACES_SEARCH_MAX_SUGGESTIONS,
} from "./internal/maps";
export {
  SEARCH_RUNGS,
  searchRung,
  type SearchRung,
} from "./internal/search-rung";
export {
  savePlace,
  SavePlaceBodySchema,
  type SavePlaceBody,
  SavePlaceResultSchema,
  type SavePlaceResult,
  PlacePositionSchema,
  type PlacePosition,
  createCustomPlace,
  CreateCustomPlaceBodySchema,
  type CreateCustomPlaceBody,
  updatePlace,
  UpdatePlaceBodySchema,
  type UpdatePlaceBody,
  deletePlace,
  regeneratePlaceIcon,
  RegeneratePlaceIconResultSchema,
  type RegeneratePlaceIconResult,
} from "./internal/endpoints";
export {
  type TagRole,
  type PlaceTagNode,
  tagIdByRole,
  NEUTRAL_PLACE_COLOR,
  tagPlaceCounts,
  isRoleTag,
  placeFlags,
  ringColors,
  mainColor,
  autoTagsFor,
} from "./internal/tag-tree";
