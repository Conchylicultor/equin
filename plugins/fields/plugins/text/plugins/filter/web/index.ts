import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { textOperatorSet } from "./operator-set";

export default {
  description:
    "Text field type: data-view filter operator set (contains / is / is-empty …).",
  contributions: [
    DataViewSlots.Filter({
      match: "text",
      companion: true,
      ...textOperatorSet,
    }),
  ],
} satisfies PluginDefinition;
