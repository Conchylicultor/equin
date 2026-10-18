import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { tagsOperatorSet } from "./operator-set";

export default {
  description:
    "Tags (multi-value) field type: data-view filter operator set (contains / contains-any-of …).",
  contributions: [
    DataViewSlots.Filter({
      match: "tags",
      companion: true,
      ...tagsOperatorSet,
    }),
  ],
} satisfies PluginDefinition;
