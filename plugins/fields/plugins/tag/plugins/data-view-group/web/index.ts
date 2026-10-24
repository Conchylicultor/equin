import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { tagGroupings } from "../core";

export default {
  description:
    "Tag field type: data-view grouping strategy — one section per tag, nested along the option forest (`FieldOption.parent`), labelled, ordered and coloured by `field.options`.",
  contributions: [
    DataViewSlots.Grouping({
      match: "tag",
      companion: true,
      label: "Group by",
      groupings: tagGroupings,
    }),
  ],
} satisfies PluginDefinition;
