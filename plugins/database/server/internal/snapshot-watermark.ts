import {
  executeOne,
  type SqlExecutable,
} from "@plugins/database/plugins/sql-rows/core";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

// The query's `::text` cast is what makes this a plain `text` column, so the
// watermark stays a string end to end and never passes through a JS number near
// 2^63.
const WatermarkRowSchema = z.object({ xmin: z.string() });

// The snapshot watermark: the xmin of the CURRENT snapshot, in the 64-bit xid8
// family (never the 32-bit txid_* forms — wraparound hole), as decimal text —
// the same encoding as `currentTxId`, so the two compare as BigInt (never
// lexically). Read-only, so it does not force an xid assignment.
//
// Every write whose xid is below it has committed or aborted: a frame read under
// a snapshot captured AFTER this call has seen it. That is what both consumers
// lean on — the resource runtime stamps it on every frame that fully reconciles a
// client (the optimistic-mutation client confirms an op whose ack token is below
// it), and L2 (live-state-snapshot) stores it as a persisted value's catch-up
// floor (its replay predicate `xid >= position` can never under-replay). The
// runtime captures it BEFORE the loader's first read; server-core's
// `setWatermarkSource` holds it, installed by this plugin's `onReadyBlocking`.
//
// Any executor — `db`, a `tx`, or a test's own drizzle client over a throwaway
// database: what it reads is whichever snapshot that connection takes.
export async function snapshotWatermark(
  exec: SqlExecutable<SQL>,
): Promise<string> {
  // A `SELECT` with no `FROM` returns exactly one row, so `executeOne` carries
  // the "no row" throw.
  const { xmin } = await executeOne(exec, {
    query: sql.raw(
      `SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin`,
    ),
    row: WatermarkRowSchema,
    label: "snapshotWatermark",
  });
  return xmin;
}
