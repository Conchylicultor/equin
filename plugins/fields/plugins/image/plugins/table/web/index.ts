import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { ImageCell } from "./components/image-cell";

export default {
  description: "Image field type: data-view table cell (read-only thumbnail).",
  contributions: [
    DataViewSlots.Cell({
      match: "image",
      companion: true,
      component: ImageCell,
    }),
  ],
} satisfies PluginDefinition;
