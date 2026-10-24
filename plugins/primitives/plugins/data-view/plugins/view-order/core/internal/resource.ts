import { liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import { RowOrderRowSchema } from "./types";

/**
 * Live per-view-instance row order, one payload per `{ dataViewId, viewId }`:
 * the rows a user dragged plus the seeds written ahead of them, **rank-ordered**
 * (`ORDER BY rank ASC`). A value, not a collection: the table's key is the
 * composite `(dataViewId, viewId, rowKey)`, so there is no single id a `:rows`
 * read could key on (the schema states the bound — `wholeList`).
 * Its loader reads `data_view_row_order`, so the change feed recomputes it on
 * every write — no notify. No placeholder: before the first value lands the
 * read is `pending`.
 */
export const rowOrder = liveValue("data-view-row-order", {
  schema: wholeList(RowOrderRowSchema, {
    reason:
      "one view instance's manual order — the rows a user dragged plus the seeds ahead of them; the key is the composite (dataViewId, viewId, rowKey), so no single-id :rows read fits",
  }),
  params: ["dataViewId", "viewId"],
});
