import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { setCustomColumnValue, deleteCustomColumnValues } from "../core";
import { handleSetCustomColumnValue } from "./internal/handle-set-custom-column-value";
import { handleDeleteCustomColumnValues } from "./internal/handle-delete-custom-column-values";
import { customColumnValuesServed } from "./internal/resource";

export { _dataViewCustomValues } from "./internal/tables";

export default {
  description:
    "Per-row custom-column VALUES keyed by (dataViewId, rowKey, columnId): the generic data_view_custom_values table, the data-view-custom-values live value over it, and the upsert/delete-on-empty and delete-column endpoints. Pure DB, so portable; the config-bound column definitions are the parent custom-columns plugin's.",
  httpRoutes: {
    [setCustomColumnValue.route]: handleSetCustomColumnValue,
    [deleteCustomColumnValues.route]: handleDeleteCustomColumnValues,
  },
  contributions: [...customColumnValuesServed.declare],
  portable: true,
} satisfies ServerPluginDefinition;
