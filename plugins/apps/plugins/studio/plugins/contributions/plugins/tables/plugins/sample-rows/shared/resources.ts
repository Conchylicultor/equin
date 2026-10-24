import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  cappedList,
  wholeRecord,
} from "@plugins/packages/plugins/list-bound/core";

/** How many rows a sample holds — the loader's `LIMIT`, and the schema's cap. */
export const SAMPLE_ROWS_LIMIT = 10;

/** Postgres's own cap on a table's columns. */
export const PG_MAX_COLUMNS = 1600;

/**
 * The first SAMPLE_ROWS_LIMIT rows of one public table (`SELECT * … LIMIT n`), with its
 * column names from the result descriptor. A snapshot: the table is any public
 * relation the reader names, and many have no change signal (a view, a
 * derived-table rollup, an `ExcludeFromChangeFeed` table such as `traces`), so
 * a `db` read-set would freeze those samples silently. It is re-read when a
 * reader asks (each mount, or `refresh()`). A table that does not exist is
 * refused `missing`.
 */
export const tableSampleRows = liveValue("studio.table-sample-rows", {
  schema: z.object({
    columns: cappedList(z.string(), { max: PG_MAX_COLUMNS }),
    rows: cappedList(
      wholeRecord(z.unknown(), {
        reason: "one row's columns — Postgres caps a table at 1,600",
      }),
      { max: SAMPLE_ROWS_LIMIT },
    ),
  }),
  params: ["tableName"],
  load: "snapshot",
  refusals: ["missing"],
});
