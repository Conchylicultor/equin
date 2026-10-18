import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { enumOperatorSet } from "./operator-set";

export default {
  description:
    "Enum (select) field type: data-view filter operator set (is / is-any-of / is-empty …).",
  contributions: [
    DataViewSlots.Filter({
      match: "enum",
      companion: true,
      ...enumOperatorSet,
    }),
  ],
} satisfies PluginDefinition;
