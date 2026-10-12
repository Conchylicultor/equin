import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { locationOperatorSet } from "./operator-set";

export default {
  description:
    "Location field type: data-view filter operator set (is set / is not set).",
  contributions: [DataViewSlots.Filter(locationOperatorSet)],
} satisfies PluginDefinition;
