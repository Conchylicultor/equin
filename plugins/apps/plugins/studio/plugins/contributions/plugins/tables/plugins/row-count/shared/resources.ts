import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

/**
 * One public table's estimated row count — `pg_stat_user_tables.n_live_tup`,
 * the statistics collector's running estimate; `null` for a relation with no
 * statistics entry (a view). A snapshot: the estimate has no change signal, so
 * it is re-measured when a reader asks (each mount, or `refresh()`). A table
 * that does not exist is refused `missing`.
 */
export const tableRowCount = liveValue("studio.table-row-count", {
  schema: z.object({ estimate: z.number().nullable() }),
  params: ["tableName"],
  load: "snapshot",
  refusals: ["missing"],
});
