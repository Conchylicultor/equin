import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { DateCell } from "./components/date-cell";

export default {
  description:
    "Date field type: data-view table cell (read-only relative-time cell).",
  contributions: [
    DataViewSlots.Cell({ match: "date", companion: true, component: DateCell }),
  ],
} satisfies PluginDefinition;
