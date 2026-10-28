import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { OrdinalCell } from "./components/ordinal-cell";

export default {
  description: "Ordinal field type: data-view table cell.",
  contributions: [
    DataViewSlots.Cell({
      match: "ordinal",
      companion: true,
      component: OrdinalCell,
    }),
  ],
} satisfies PluginDefinition;
