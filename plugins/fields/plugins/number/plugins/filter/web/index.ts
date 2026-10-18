import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { numberOperatorSet } from "./operator-set";

export default {
  description:
    "Number field type: data-view filter operator set (= ≠ > < ≥ ≤ between is-empty …).",
  contributions: [
    DataViewSlots.Filter({
      match: "number",
      companion: true,
      ...numberOperatorSet,
    }),
  ],
} satisfies PluginDefinition;
