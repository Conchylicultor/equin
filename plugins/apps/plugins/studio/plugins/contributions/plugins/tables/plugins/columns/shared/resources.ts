import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

export const ColumnSchema = z.object({
  column_name: z.string(),
  data_type: z.string(),
  is_nullable: z.string(),
  column_default: z.string().nullable(),
  ordinal_position: z.number(),
});

/**
 * One public table's columns, in ordinal order, read from
 * `information_schema.columns`. Served external `fixed`: the schema is migrated
 * at boot, before any read, and no DDL runs mid-process. A table that does not
 * exist is refused `missing`.
 */
export const tableColumns = liveValue("studio.table-columns", {
  schema: z.object({ columns: z.array(ColumnSchema) }),
  params: ["tableName"],
  refusals: ["missing"],
});
