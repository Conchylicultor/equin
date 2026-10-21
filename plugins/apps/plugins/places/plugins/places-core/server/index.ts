import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { IdKinds } from "@plugins/ids/server";
import {
  createCustomPlace,
  createPlaceTag,
  deletePlace,
  deletePlaceTag,
  placeIdKind,
  placeTagIdKind,
  regeneratePlaceIcon,
  savePlace,
  updatePlace,
  updatePlaceTag,
} from "../core";
import {
  handleCreateCustomPlace,
  handleCreatePlaceTag,
  handleDeletePlace,
  handleDeletePlaceTag,
  handleRegeneratePlaceIcon,
  handleSavePlace,
  handleUpdatePlace,
  handleUpdatePlaceTag,
} from "./internal/handlers";
import {
  placeSearchServed,
  placesServed,
  placeTagsServed,
} from "./internal/resources";
import { placeIconJob } from "./internal/place-icon";
import { refreshPlacesJob } from "./internal/refresh-job";
import { seedPlaceTagsWarmup } from "./internal/seed";

export {
  insertPlace,
  type NewPlace,
  type InsertPlaceExtras,
  type InsertPlaceResult,
} from "./internal/places-repo";
export { searchPlaces } from "./internal/places-repo";
export { replaceAllPlaces, type ImportedPlace } from "./internal/replace-all";
export type { SeedTagKey } from "./internal/seed-tags";

export default {
  description:
    "Contract layer for the Places app: the places / place_tags entities, the starter tag tree seeded on an empty install, the live places and tags collections, Google Places search and save (auto-tagged from the place's Google types, tagged Want to go), custom places (a named pin with no Google place behind it), the user's own title over Google's name, place and tag CRUD (a deleted tag's children and places move to its parent), the Haiku job that picks each place's Material Symbols icon, and the monthly job that re-fetches each place's Google details (whether it is still open).",
  register: [placeIconJob, refreshPlacesJob, seedPlaceTagsWarmup],
  httpRoutes: {
    [savePlace.route]: handleSavePlace,
    [createCustomPlace.route]: handleCreateCustomPlace,
    [updatePlace.route]: handleUpdatePlace,
    [deletePlace.route]: handleDeletePlace,
    [regeneratePlaceIcon.route]: handleRegeneratePlaceIcon,
    [createPlaceTag.route]: handleCreatePlaceTag,
    [updatePlaceTag.route]: handleUpdatePlaceTag,
    [deletePlaceTag.route]: handleDeletePlaceTag,
  },
  contributions: [
    IdKinds.Kind({ kind: placeIdKind }),
    IdKinds.Kind({ kind: placeTagIdKind }),
    ...placesServed.declare,
    ...placeTagsServed.declare,
    ...placeSearchServed.declare,
  ],
} satisfies ServerPluginDefinition;
