import { serveCollection } from "@plugins/network/plugins/live/server";
import { rowOrder } from "../../core";
import { rowOrderEntity } from "./tables";

/**
 * Serves `rowOrder` from `data_view_row_order`, one scoped tuple per
 * `(dataViewId, viewId)` — the twin of custom-columns' `customColumnValuesServed`.
 * Compiled from the table (query-resource's `compileAllCollection`); the
 * endpoint notifies nothing — the change feed carries the write.
 */
export const rowOrderServed = serveCollection(rowOrder, {
  from: rowOrderEntity,
});
