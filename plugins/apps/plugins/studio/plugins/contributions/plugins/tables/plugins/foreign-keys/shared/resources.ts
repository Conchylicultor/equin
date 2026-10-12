import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

export const OutgoingFkSchema = z.object({
  constraint_name: z.string(),
  column_name: z.string(),
  foreign_table: z.string(),
  foreign_column: z.string(),
});

export const IncomingFkSchema = z.object({
  constraint_name: z.string(),
  source_table: z.string(),
  source_column: z.string(),
  target_column: z.string(),
});

/**
 * One public table's foreign keys — the ones it declares (`outgoing`) and the
 * ones pointing at it (`incoming`) — read from `information_schema`. Served
 * external `fixed`: the schema is migrated at boot, before any read, and no DDL
 * runs mid-process. A table that does not exist is refused `missing`.
 */
export const tableForeignKeys = liveValue("studio.table-foreign-keys", {
  schema: z.object({
    outgoing: z.array(OutgoingFkSchema),
    incoming: z.array(IncomingFkSchema),
  }),
  params: ["tableName"],
  refusals: ["missing"],
});
