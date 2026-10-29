import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { enumField } from "@plugins/fields/plugins/enum/plugins/config/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { TABLE_SLOTS, TableView } from "./components/table-view";
import { symbol } from "@plugins/ui/plugins/icons/core";

export type { TableViewOptions } from "../core";

export default {
  description:
    "Table view for data-view: maps the typed field schema to data-table columns with host-controlled sort, and nests its rows (a tree is a table with no columns) when the source has a hierarchy.",
  contributions: [
    DataViewSlots.View({
      type: "table",
      companion: true,
      title: "Table",
      icon: symbol("table-rows"),
      loadingVariant: "rows",
      loadingCount: 6,
      component: TableView,
      slots: TABLE_SLOTS,
      // Opts into flat manual-order (rank-based drag reorder); active only when
      // the consumer supplies `manualOrder`.
      supportsManualOrder: true,
      // Nests its rows over a hierarchical source — the host then applies no
      // fold and no flat manual order to it, and honours its `filterScope`.
      nestsHierarchy: true,
      // The view's settings panel: the column labels — automatic (the code's
      // `header` / the presentation's default), shown or hidden. See
      // `TableViewOptions.columnCaptions`.
      configSchema: {
        columnCaptions: enumField({
          label: "Column captions",
          description:
            "Show the column labels above the rows. Automatic: shown, except in an outline.",
          options: [
            { value: "auto", label: "Automatic" },
            { value: "shown", label: "Shown" },
            { value: "hidden", label: "Hidden" },
          ],
          default: "auto",
        }),
      },
    }),
  ],
} satisfies PluginDefinition;
