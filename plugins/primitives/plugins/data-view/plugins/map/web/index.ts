import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { MapDataView } from "./components/map-data-view";

export type { MapViewOptions } from "../core";

export default {
  description:
    "Map view child for the data-view primitive: every row with a location as a pin on a full-bleed map, clustered, with clicking a pin activating its row.",
  contributions: [
    DataViewSlots.View({
      type: "map",
      companion: true,
      title: "Map",
      icon: symbol("map"),
      // A map has no section axis, no fold line and no rank order: its
      // position is the row's location.
      supportsGroupBy: false,
      supportsFold: false,
      supportsManualOrder: false,
      // The map is the surface's canvas: under a floating toolbar it runs
      // under the band and the aside, edge to edge.
      fullBleed: true,
      configSchema: {
        locationField: textField({
          label: "Location field",
          description:
            "Field id whose value places each row on the map (default: the first location field).",
        }),
      },
      component: MapDataView,
    }),
  ],
} satisfies PluginDefinition;
