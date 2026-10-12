import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { GeoMap } from "@plugins/map/web";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { placesMapPane } from "./panes";
import { SavedPlacePin } from "./components/saved-place-pin";
import { SavedPlaceCluster } from "./components/saved-place-cluster";
import { SAVED_PLACE_PIN_TYPE } from "./internal/place-visual";

export default {
  description:
    "The Places app's index pane (/places): every saved place in one full-bleed DataView (Map, Gallery, List) with its chrome floating on the map — the tag sidebar owning the tag half of the view filter (include / exclude, any / all, faceted counts), the Add place search, the selected place's card — plus the saved-place drop pin and its colour-ringed cluster.",
  contributions: [
    Pane.Register({ pane: placesMapPane }),
    GeoMap.Pin({ match: SAVED_PLACE_PIN_TYPE, component: SavedPlacePin }),
    GeoMap.Cluster({
      match: SAVED_PLACE_PIN_TYPE,
      component: SavedPlaceCluster,
    }),
  ],
  slots: { "places-map": placesMapPane },
} satisfies PluginDefinition;
