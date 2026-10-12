import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { IdKinds } from "@plugins/ids/web";
import { placeIdKind, placeTagIdKind } from "../core";

export {
  usePlaces,
  usePlaceRow,
  usePlaceTags,
  usePlaceSearch,
  useSavePlace,
  useUpdatePlace,
  useDeletePlace,
  useRegeneratePlaceIcon,
  useCreatePlaceTag,
  useUpdatePlaceTag,
  useDeletePlaceTag,
} from "./internal/hooks";

export default {
  description:
    "Contract layer for the Places app, web half: the live places and tag-tree hooks, the Google Places search read, and the place and tag mutations.",
  contributions: [
    IdKinds.Kind({ kind: placeIdKind }),
    IdKinds.Kind({ kind: placeTagIdKind }),
  ],
} satisfies PluginDefinition;
