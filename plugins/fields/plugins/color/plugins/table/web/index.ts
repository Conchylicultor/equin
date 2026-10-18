import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { ColorCell } from "./components/color-cell";

export default {
  description:
    "Color field type: data-view table cell (read-only color swatch).",
  contributions: [
    DataViewSlots.Cell({
      match: "color",
      companion: true,
      component: ColorCell,
    }),
  ],
} satisfies PluginDefinition;
