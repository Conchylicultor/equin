import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { dateOperatorSet } from "./operator-set";

export default {
  description:
    "Date field type: data-view filter operator set (is / before / after / between …).",
  contributions: [
    DataViewSlots.Filter({
      match: "date",
      companion: true,
      ...dateOperatorSet,
    }),
  ],
} satisfies PluginDefinition;
