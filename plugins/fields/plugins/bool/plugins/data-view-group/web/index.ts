import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { boolGroupings } from "../core";

export default {
  description:
    "Boolean field type: data-view grouping strategy (Yes / No sections, false first).",
  contributions: [
    DataViewSlots.Grouping({
      match: "bool",
      companion: true,
      label: "Group by",
      groupings: boolGroupings,
    }),
  ],
} satisfies PluginDefinition;
