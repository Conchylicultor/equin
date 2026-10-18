import { executeOne } from "@plugins/database/plugins/sql-rows/core";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./driver";

// db-or-tx executor, same shape as RankExecutor
// (plugins/primitives/plugins/rank/server/internal/helpers.ts).
export type DbExecutor =
  typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// The current transaction's xid8 as decimal text — the causal ack token mutation
// endpoints return so the optimistic-mutation primitive can compare it against
// snapshot watermarks (`pg_snapshot_xmin(pg_current_snapshot())`, same xid8 text
// encoding — compare as BigInt, never lexically). Call it INSIDE the write
// transaction (pass the `tx`): the write already assigned the xid, so the read is
// free; `pg_current_xact_id()` would otherwise assign a fresh xid to whatever
// pool connection it lands on, tokenizing nothing.
export async function currentTxId(exec: DbExecutor): Promise<string> {
  // A bare function call always returns exactly one row; `executeOne` throws if
  // it somehow does not, so there is no absent-xid arm to absorb.
  const { xid } = await executeOne(exec, {
    query: sql.raw(`SELECT pg_current_xact_id()::text AS xid`),
    row: z.object({ xid: z.string() }),
    label: "currentTxId",
  });
  return xid;
}
