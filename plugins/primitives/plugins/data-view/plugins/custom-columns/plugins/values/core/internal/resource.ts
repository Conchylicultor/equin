import { liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import { CustomColumnValueRowSchema } from "./types";

/**
 * Live per-surface custom-column values, one payload per `{ dataViewId }`: every
 * cell of that surface's custom columns, indexed client-side onto each rendered
 * row. A value, not a collection: the table's key is the composite
 * `(dataViewId, rowKey, columnId)`, so there is no single id a `:rows` read
 * could key on (the schema states the bound — `wholeList`). Its
 * loader reads `data_view_custom_values`, so the change feed recomputes it on
 * every write — no notify. No placeholder: before the first value lands the
 * read is `pending`.
 */
export const customColumnValues = liveValue("data-view-custom-values", {
  schema: wholeList(CustomColumnValueRowSchema, {
    reason:
      "one DataView surface's custom-column cells, indexed client-side onto every rendered row; the key is the composite (dataViewId, rowKey, columnId), so no single-id :rows read fits",
  }),
  params: ["dataViewId"],
});
