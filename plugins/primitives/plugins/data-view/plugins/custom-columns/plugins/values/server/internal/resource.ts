import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { customColumnValues } from "../../core";
import { _dataViewCustomValues } from "./tables";

/**
 * Serves `customColumnValues` from `data_view_custom_values`, scoped by
 * `dataViewId`. The declared `reads` name the table, so the change feed
 * recomputes the tuple on every write — the handlers notify nothing.
 */
export const customColumnValuesServed = serveValue(customColumnValues, {
  source: "db",
  reads: {
    tables: [_dataViewCustomValues],
    reason:
      "a write to any custom-value row may change the cells of the surface it belongs to; whole-table until it reads through a collection",
  },
  unbounded: {
    reason:
      "one DataView surface's custom-column cells, indexed client-side onto every rendered row; the key is the composite (dataViewId, rowKey, columnId), so no single-id :rows read fits",
  },
  loader: async ({ dataViewId }) =>
    db
      .select({
        rowKey: _dataViewCustomValues.rowKey,
        columnId: _dataViewCustomValues.columnId,
        value: _dataViewCustomValues.value,
      })
      .from(_dataViewCustomValues)
      .where(eq(_dataViewCustomValues.dataViewId, dataViewId)),
});
