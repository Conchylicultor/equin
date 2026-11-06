import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { IdKinds } from "@plugins/ids/server";
import {
  serveTagTree,
  TagTrees,
} from "@plugins/tag-tree/plugins/engine/server";
import {
  createCustomPlace,
  deletePlace,
  placeIdKind,
  placeTagIdKind,
  placeTagTree,
  updatePlace,
} from "../core";
import {
  handleCreateCustomPlace,
  handleDeletePlace,
  handleUpdatePlace,
} from "./internal/handlers";
import { placesServed, placeTagsServed } from "./internal/resources";
import { placeIconJob } from "./internal/place-icon";
import { seedPlaceTagsWarmup } from "./internal/seed";

export { seedStarterPlaceTags } from "./internal/seed";
import { placeTagsCarrier } from "./internal/tag-carrier";
import { _placeTags } from "./internal/tables";

export {
  insertPlace,
  type NewPlace,
  type InsertPlaceExtras,
  type InsertPlaceResult,
} from "./internal/places-repo";
export { PlaceIconPicker } from "./internal/place-icon";
export { replaceAllPlaces, type ImportedPlace } from "./internal/replace-all";
export type { SeedTagKey } from "./internal/seed-tags";

export default {
  description:
    "Contract layer for the Places app, portable half: the places / place_tags entities, the starter tag tree seeded on an empty install, the live places and tags collections, custom places (a named pin with no Google place behind it), the user's own title over Google's name, place CRUD, the tag tree served through the tag-tree engine (a deleted tag's children and places move to its parent; Been / Want to go cannot be deleted), and the job that picks each new place's Material Symbols icon through the host's PlaceIconPicker (Haiku on the computer; none on a browser host, where a pin keeps its tag's icon).",
  register: [placeIconJob, seedPlaceTagsWarmup],
  httpRoutes: {
    [createCustomPlace.route]: handleCreateCustomPlace,
    [updatePlace.route]: handleUpdatePlace,
    [deletePlace.route]: handleDeletePlace,
  },
  contributions: [
    IdKinds.Kind({ kind: placeIdKind }),
    IdKinds.Kind({ kind: placeTagIdKind }),
    ...placesServed.declare,
    ...placeTagsServed.declare,
    TagTrees.Tree(
      serveTagTree(placeTagTree, {
        table: _placeTags,
        carriers: [placeTagsCarrier],
        editableExtras: ["googleTypes"],
        // The app resolves Been / Want to go by role: those are never deleted.
        refuseDelete: (t) =>
          t.role !== null ? `The ${t.name} tag cannot be deleted` : null,
      }),
    ),
  ],
} satisfies ServerPluginDefinition;
