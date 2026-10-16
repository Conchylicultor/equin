import { and, asc, eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { rowOrder } from "../../core";
import { _dataViewRowOrder } from "./tables";

/**
 * Serves `rowOrder` from `data_view_row_order`, scoped by `(dataViewId,
 * viewId)` — the twin of custom-columns' `customColumnValuesServed`. The
 * declared `reads` name the table, so the change feed recomputes the tuple on
 * every write — the endpoint notifies nothing.
 *
 * Rows are emitted rank-ascending — the client's `seedRanks` reads the whole map
 * anyway, but a rank-ordered payload keeps the wire shape self-describing.
 */
export const rowOrderServed = serveValue(rowOrder, {
  source: "db",
  reads: {
    tables: [_dataViewRowOrder],
    reason:
      "a write to any row-order row may change the manual order of the view instance it belongs to; whole-table until it reads through a collection",
  },
  unbounded: {
    reason:
      "one view instance's manual order — the rows a user dragged plus the seeds ahead of them; the key is the composite (dataViewId, viewId, rowKey), so no single-id :rows read fits",
  },
  loader: async ({ dataViewId, viewId }) => {
    const rows = await db
      .select({
        rowKey: _dataViewRowOrder.rowKey,
        rank: _dataViewRowOrder.rank,
      })
      .from(_dataViewRowOrder)
      .where(
        and(
          eq(_dataViewRowOrder.dataViewId, dataViewId),
          eq(_dataViewRowOrder.viewId, viewId),
        ),
      )
      .orderBy(asc(_dataViewRowOrder.rank));
    // `rank_text` stores the raw key; wrap it in the branded `Rank` the schema
    // (and every consumer) is typed against.
    return rows.map((row) => ({
      rowKey: row.rowKey,
      rank: Rank.from(row.rank),
    }));
  },
});
