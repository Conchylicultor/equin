export { placeFields, placeTagFields } from "./internal/fields";
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
export { places, placeTags, placeSearch } from "./internal/resources";
export {
  MapsNotConfiguredSchema,
  PlaceBoundsSchema,
  type PlaceBounds,
  PlaceSearchQuerySchema,
  type PlaceSearchQuery,
  PlaceSearchResultSchema,
  type PlaceSearchResult,
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
  createPlaceTag,
  CreatePlaceTagBodySchema,
  type CreatePlaceTagBody,
  updatePlaceTag,
  UpdatePlaceTagBodySchema,
  type UpdatePlaceTagBody,
  deletePlaceTag,
} from "./internal/endpoints";
export {
  type TagRole,
  type ChildColorMode,
  tagIdByRole,
  NEUTRAL_PLACE_COLOR,
  type TagNode,
  tagColor,
  tagPath,
  tagDescendants,
  flattenTagTree,
  type TagTreeEntry,
  tagPlaceCounts,
  isTagUnder,
  isRoleTag,
  placeFlags,
  ringColors,
  mainColor,
  autoTagsFor,
  wouldCycle,
} from "./internal/tag-tree";
