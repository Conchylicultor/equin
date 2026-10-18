import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { ListView } from "./components/list-view";
import { symbol } from "@plugins/ui/plugins/icons/core";

export type { ListViewOptions } from "../core";

export default {
  description:
    "List view child for the data-view primitive: a compact single-row-per-item list (Row primitive) with field-driven label/subtitle/trailing, active-row highlight, and hover item actions.",
  contributions: [
    DataViewSlots.View({
      type: "list",
      companion: true,
      title: "List",
      icon: symbol("view-list"),
      order: 3,
      loadingVariant: "rows",
      component: ListView,
      // Opts into flat manual-order (rank-based drag reorder); active only when
      // the consumer supplies `manualOrder`.
      supportsManualOrder: true,
    }),
  ],
} satisfies PluginDefinition;
