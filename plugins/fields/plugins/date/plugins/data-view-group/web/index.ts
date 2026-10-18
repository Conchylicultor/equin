import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { dateGroupings } from "../core";

export default {
  description:
    "Date field type: data-view grouping strategies (smart, day, week, month, year).",
  contributions: [
    DataViewSlots.Grouping({
      match: "date",
      companion: true,
      label: "Group dates by",
      groupings: dateGroupings,
    }),
  ],
} satisfies PluginDefinition;
