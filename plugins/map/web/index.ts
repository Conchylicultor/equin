import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { GeoMap } from "./slots";

export { GeoMap } from "./slots";
export type {
  MapRendererContribution,
  MapRendererProps,
  MapRendererReadiness,
  MapPinProps,
  MapPinScale,
  MapPinState,
  MapClusterProps,
  MapMarkEnv,
  MapPinMarkFn,
  MapPinMarkInput,
  MapClusterMarkFn,
} from "./slots";
export { MapView } from "./components/map-view";
export {
  MAP_LABEL_HALO_PX,
  MAP_LABEL_PAINT,
  MapLabel,
  type MapLabelProps,
} from "./components/map-label";
export {
  MapMarkImage,
  useMapMarkEnv,
  useMapTextStyle,
  type MapTextStyle,
} from "./components/mark-env";
export type { MapViewProps } from "./components/map-view";

export default {
  description:
    "Vendor-neutral map primitive: <MapView overlays/> draws pins, paths and areas through the first GeoMap.Renderer (showing its set-up action while it is blocked, and a loud state when none is installed), with every pin's look contributed through the GeoMap.Pin dispatch slot keyed on its pinType, and a crowd mode the caller picks: clustering (every group of nearby pins drawn through the GeoMap.Cluster dispatch slot keyed on the pinType its pins share) or spots (every pin stays drawn — far out as a compact centred mark, with the size of each spot beside its lead pin).",
  slots: GeoMap,
} satisfies PluginDefinition;
