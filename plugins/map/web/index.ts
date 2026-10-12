import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { GeoMap } from "./slots";

export { GeoMap } from "./slots";
export type {
  MapRendererContribution,
  MapRendererProps,
  MapRendererReadiness,
  MapPinProps,
  MapClusterProps,
} from "./slots";
export { MapView } from "./components/map-view";
export { MapLabel, type MapLabelProps } from "./components/map-label";
export type { MapViewProps } from "./components/map-view";

export default {
  description:
    "Vendor-neutral map primitive: <MapView overlays/> draws pins, paths and areas through the first GeoMap.Renderer (showing its set-up action while it is blocked, and a loud state when none is installed), with every pin's look contributed through the GeoMap.Pin dispatch slot keyed on its pinType, and — when the caller asks for clustering — every group of nearby pins drawn through the GeoMap.Cluster dispatch slot keyed on the pinType its pins share.",
  slots: GeoMap,
} satisfies PluginDefinition;
