import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { liveMapSetupPane } from "./panes";

export {
  useMapsAccess,
  type MapsAccess,
  type MapsAccessBlocker,
  type MapsAccessCapability,
} from "./internal/use-maps-access";
export {
  useMapsBrowserConfig,
  type MapsBrowserConfigState,
} from "./internal/use-maps-browser-config";
export {
  MapsAccessAction,
  MAPS_BLOCKER_BODY,
} from "./components/maps-access-action";
export { MapsMapAccessAction } from "./components/maps-map-access-action";
export { MapIdRasterNotice } from "./components/map-id-raster-notice";
export {
  reportMapRendering,
  type MapRendering,
} from "./internal/map-rendering-report";

export default {
  description:
    "Google Maps Platform access broker (web): per-capability readiness (Places lookups vs the live map), the public browser config read, the 'set up Google Maps' / 'set up the live map' affordances consumers render in place of routing the user to Settings, and the Live map setup pane (browser key, plus the optional vector-map Map ID, checked against how Google actually drew the map).",
  contributions: [Pane.Register({ pane: liveMapSetupPane })],
  slots: { "google-maps-live-map-setup": liveMapSetupPane },
} satisfies PluginDefinition;
