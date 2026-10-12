import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

/**
 * The first 10 rows of one public table (`SELECT * … LIMIT 10`), with its
 * column names from the result descriptor. A snapshot: the table is any public
 * relation the reader names, and many have no change signal (a view, a
 * derived-table rollup, an `ExcludeFromChangeFeed` table such as `traces`), so
 * a `db` read-set would freeze those samples silently. It is re-read when a
 * reader asks (each mount, or `refresh()`). A table that does not exist is
 * refused `missing`.
 */
export const tableSampleRows = liveValue("studio.table-sample-rows", {
  schema: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.record(z.unknown())),
  }),
  params: ["tableName"],
  load: "snapshot",
  refusals: ["missing"],
});
