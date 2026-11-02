import { serveCollection } from "@plugins/network/plugins/live/server";
import { customColumnValues } from "../../core";
import { customColumnValuesEntity } from "./tables";

/**
 * Serves `customColumnValues` from `data_view_custom_values`, one scoped tuple
 * per `dataViewId`, compiled from the table (query-resource's
 * `compileAllCollection`). The handlers notify nothing — the change feed
 * carries the write, routed by its `data_view_id`.
 */
export const customColumnValuesServed = serveCollection(customColumnValues, {
  from: customColumnValuesEntity,
});
