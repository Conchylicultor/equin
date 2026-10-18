import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { boolOperatorSet } from "./operator-set";

export default {
  description:
    "Boolean field type: data-view filter operator set (is checked/unchecked).",
  contributions: [
    DataViewSlots.Filter({
      match: "bool",
      companion: true,
      ...boolOperatorSet,
    }),
  ],
} satisfies PluginDefinition;
