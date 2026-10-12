import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { LocationCell } from "./components/location-cell";

export default {
  description:
    "Location field type: data-view table cell (address, else lat, lng).",
  contributions: [
    DataViewSlots.Cell({ match: "location", component: LocationCell }),
  ],
} satisfies PluginDefinition;
