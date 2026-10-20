import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { CustomColumnValueRowSchema } from "./types";

/**
 * Live per-surface custom-column values, one payload per `{ dataViewId }`: every
 * cell of that surface's custom columns, indexed client-side onto each rendered
 * row. A value, not a collection: the table's key is the composite
 * `(dataViewId, rowKey, columnId)`, so there is no single id a `:rows` read
 * could key on (the server states the bound — `unbounded: { reason }`). Its
 * loader reads `data_view_custom_values`, so the change feed recomputes it on
 * every write — no notify. No placeholder: before the first value lands the
 * read is `pending`.
 */
export const customColumnValues = liveValue("data-view-custom-values", {
  schema: z.array(CustomColumnValueRowSchema),
  params: ["dataViewId"],
});
