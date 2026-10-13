import { desc } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { slowOpsValue } from "../../core";
import { _slowOps } from "./tables";

// The table row type and the `SlowOp` wire schema both derive from the single
// `slowOpFields` record (core), so `_slowOps.$inferSelect ≡ SlowOp` by
// construction — the rows are returned verbatim with no projection.
//
// Ranked by aggregate impact (total time desc) — the pane's default ordering.
//
// External, not `db`: `slow_ops` is excluded from the change feed, so a `db`
// read-set would never fire and the pane would sit frozen while labelled
// fresh. `no-db-backed-notify` admits this Postgres read with no exemption:
// it reads only a table this plugin itself excludes from the feed.
export const slowOpsServed = serveValue(slowOpsValue, {
  source: "external",
  changes: {
    snapshot: {
      reason:
        "slow_ops is excluded from the change feed — batch recording is a read-modify-write transaction a change producer cannot express; re-measured on open / Refresh",
    },
  },
  loader: async () =>
    db.select().from(_slowOps).orderBy(desc(_slowOps.totalMs)),
});
