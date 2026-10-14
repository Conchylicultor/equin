import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  DataTable,
  VIRTUALIZE_THRESHOLD as DATA_TABLE_VIRTUALIZE_THRESHOLD,
} from "./internal/data-table";
export type {
  ColumnDef,
  DataTableProps,
  DataTableGroup,
  DataTablePresentation,
  DataTableRowDecoration,
  DataTableSelection,
  DataTableTree,
} from "./internal/types";
export type { SortState } from "./internal/use-data-table";

export default {
  description: "Sortable/filterable flex-layout data table primitive.",
  contributions: [],
} satisfies PluginDefinition;
