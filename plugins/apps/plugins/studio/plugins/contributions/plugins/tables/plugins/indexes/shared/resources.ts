import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";

export const IndexSchema = z.object({
  indexname: z.string(),
  indexdef: z.string(),
});

/**
 * One public table's indexes, by name, read from `pg_indexes`. Served external
 * `fixed`: the schema is migrated at boot, before any read, and no DDL runs
 * mid-process. A table that does not exist is refused `missing`.
 */
export const tableIndexes = liveValue("studio.table-indexes", {
  schema: z.object({
    indexes: wholeList(IndexSchema, {
      reason: "one table's indexes — a handful, each declared in its schema",
    }),
  }),
  params: ["tableName"],
  refusals: ["missing"],
});
