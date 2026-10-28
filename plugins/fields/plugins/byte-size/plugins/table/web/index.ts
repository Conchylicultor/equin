import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { ByteSizeCell } from "./components/byte-size-cell";

export default {
  description: "Byte size field type: data-view table cell.",
  contributions: [
    DataViewSlots.Cell({
      match: "byte-size",
      companion: true,
      component: ByteSizeCell,
    }),
  ],
} satisfies PluginDefinition;
