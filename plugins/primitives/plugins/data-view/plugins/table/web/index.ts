import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { TableView } from "./components/table-view";
import { symbol } from "@plugins/ui/plugins/icons/core";

export type { TableViewOptions } from "../core";

export default {
  description:
    "Table view for data-view: maps the typed field schema to data-table columns with host-controlled sort, and nests its rows (a tree is a table with no columns) when the source has a hierarchy.",
  contributions: [
    DataViewSlots.View({
      type: "table",
      title: "Table",
      icon: symbol("table-rows"),
      order: 1,
      loadingVariant: "rows",
      loadingCount: 6,
      component: TableView,
      // Opts into flat manual-order (rank-based drag reorder); active only when
      // the consumer supplies `manualOrder`.
      supportsManualOrder: true,
      // Nests its rows over a hierarchical source (NOT `hierarchical`: it stays
      // offered on flat sources) — the host then applies no fold and no flat
      // manual order to it, and honours its `filterScope`.
      nestsHierarchy: true,
    }),
  ],
} satisfies PluginDefinition;
