import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { IdKinds } from "@plugins/ids/server";
import {
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
import { seedPlaceTagsWarmup } from "./internal/seed";

export default {
  description:
    "Contract layer for the Places app: the places / place_tags entities, the starter tag tree seeded on an empty install, the live places and tags collections, Google Places search and save (auto-tagged from the place's Google types, tagged todo), place and tag CRUD (a deleted tag's children and places move to its parent), and the Haiku job that picks each place's Material Symbols icon.",
  register: [placeIconJob, seedPlaceTagsWarmup],
  httpRoutes: {
    [savePlace.route]: handleSavePlace,
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
