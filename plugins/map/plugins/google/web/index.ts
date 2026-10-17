import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { GeoMap } from "@plugins/map/web";
import {
  LiveMapSetup,
  MapsMapAccessAction,
} from "@plugins/integrations/plugins/google-maps/web";
import { MapIdPreview } from "./components/map-id-preview";
import { GoogleMapRenderer } from "./components/google-map-renderer";
import { useGoogleMapReadiness } from "./internal/readiness";
import { GOOGLE_TILES } from "./internal/tiles";

export default {
  description:
    "Google Maps JavaScript API as the map renderer: draws GeoMap overlays (pins as overlays holding each pin's contributed content, Google's own places hidden, paths as polylines, areas as polygons, strokes in resolved theme tones), frames them once and then only from its Fit control, shows the live-map set-up action until a browser key is set, and replaces Google's silent grey map with an error card when the key is refused. Draws the Live map setup's Map ID preview map. Lazily loaded off the boot wave.",
  contributions: [
    GeoMap.Renderer({
      id: "google",
      label: "Google Maps",
      component: GoogleMapRenderer,
      tiles: GOOGLE_TILES,
      // Rendered by the host in place of the map while no browser key is set —
      // the host never learns that the blocker is a key.
      AccessAction: MapsMapAccessAction,
      useReadiness: useGoogleMapReadiness,
    }),
    // The Live map setup's Map ID check draws its preview map here.
    LiveMapSetup.MapIdPreview({ match: "preview", component: MapIdPreview }),
  ],
} satisfies PluginDefinition;
