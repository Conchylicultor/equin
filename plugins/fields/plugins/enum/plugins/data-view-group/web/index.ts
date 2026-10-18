import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { enumGroupings } from "../core";

export default {
  description:
    "Enum field type: data-view grouping strategy (bucket by value, labelled and ordered by `field.options`).",
  contributions: [
    DataViewSlots.Grouping({
      match: "enum",
      companion: true,
      label: "Group by",
      groupings: enumGroupings,
    }),
  ],
} satisfies PluginDefinition;
