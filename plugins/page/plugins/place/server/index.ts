import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { placeBlock } from "../core";
import {
  placeResolveServed,
  placeSearchServed,
} from "./internal/lookups-served";

export { definePlaceProvider, getPlaceProvider } from "./internal/registry";
export type { PlaceProvider } from "./internal/registry";

export default {
  description:
    "Place block server half: the definePlaceProvider registry plus the two provider-agnostic live lookups (place.search, place.resolve), which dispatch by `providerId` and name no provider. Also registers the place `data` schema at the server write boundary.",
  contributions: [
    Editor.BlockData(placeBlock),
    ...placeSearchServed.declare,
    ...placeResolveServed.declare,
  ],
} satisfies ServerPluginDefinition;
