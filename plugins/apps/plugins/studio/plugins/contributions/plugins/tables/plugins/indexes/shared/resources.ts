import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

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
  schema: z.object({ indexes: z.array(IndexSchema) }),
  params: ["tableName"],
  refusals: ["missing"],
});
