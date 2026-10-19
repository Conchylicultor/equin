import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { GeoMap } from "@plugins/map/web";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { placesMapPane } from "./panes";
import { SavedPlacePin, savedPlaceMark } from "./components/saved-place-pin";
import { placePresentation } from "./internal/fields";
import { SAVED_PLACE_PIN_TYPE } from "./internal/place-visual";
import {
  GoogleResultPin,
  googleResultMark,
} from "./components/google-result-pin";
import { GOOGLE_RESULT_PIN_TYPE } from "./internal/google-result";

export default {
  description:
    "The Places app's index pane (/places): every saved place in one full-bleed DataView (Map, Gallery, List) with its chrome floating on the map — the tag sidebar owning the tag half of the view filter (include / exclude, any / all, faceted counts), the \"Search or add places\" bar (your places filtered live, Google's hits around the map's view as cards to save and as ghost pins hover-linked with them, the camera never moving), the selected place's card — plus the saved-place pin (a drop near, a round badge far out with each spot's size beside it) and the Google result's ghost pin.",
  contributions: [
    Pane.Register({ pane: placesMapPane }),
    placePresentation,
    GeoMap.Pin({
      match: SAVED_PLACE_PIN_TYPE,
      component: SavedPlacePin,
      mark: savedPlaceMark,
    }),
    GeoMap.Pin({
      match: GOOGLE_RESULT_PIN_TYPE,
      component: GoogleResultPin,
      mark: googleResultMark,
    }),
  ],
  slots: { "places-map": placesMapPane },
} satisfies PluginDefinition;
