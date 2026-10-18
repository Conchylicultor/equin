import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { IconsView } from "./components/icons-view";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Icons view child for the data-view primitive: a centred launcher grid of fixed-size tiles (the row's leading avatar filling a squircle) with the name underneath, drag-to-reorder in manual order.",
  contributions: [
    DataViewSlots.View({
      type: "icons",
      companion: true,
      title: "Icons",
      icon: symbol("apps"),
      order: 5,
      loadingVariant: "cards",
      component: IconsView,
      // Opts into flat manual-order: a grid renders one linear rank, so a tile's
      // left half drops before it and its right half after it.
      supportsManualOrder: true,
    }),
  ],
} satisfies PluginDefinition;
