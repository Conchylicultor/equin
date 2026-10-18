import { describe, test, expect } from "bun:test";
import { sql } from "drizzle-orm";
import { db, DatabaseDriver } from "./driver";
import { currentTxId } from "./current-tx-id";

// Real-DB invariant suite for the causal ack token: xid8 text is BigInt-parseable,
// strictly increasing across committed write transactions, and comparable with the
// snapshot watermark (`pg_snapshot_xmin(pg_current_snapshot())` — the exact SQL
// live-state-snapshot's captureWatermark runs). The last one pins the Rule A↔B
// comparability the optimistic-mutation confirmation depends on, on real Postgres.
//
// Runs against the plugin's OWN worktree DB (the bun-test preload declares the
// current checkout as this process's namespace) rather than a db-test-fixture
// throwaway: the fixture is a CHILD plugin of database, so importing it from
// here would form a parent↔child cycle (plugin-boundaries). Safe because the
// suite only reads xids and writes a session-scoped TEMP table (ON COMMIT DROP)
// — nothing persists in the worktree DB.

// One committed write transaction, returning the token captured INSIDE it. The
// write is a real INSERT into a temp table (ON COMMIT DROP — session-scoped, so
// no migration chain and nothing persists) rather than relying on
// pg_current_xact_id()'s own xid assignment, so the test exercises the exact
// shape consumers use: capture alongside genuine edge writes in the same tx.
async function writeTxCapturingToken(): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql.raw(`CREATE TEMP TABLE txid_probe (n int) ON COMMIT DROP`),
    );
    await tx.execute(sql.raw(`INSERT INTO txid_probe VALUES (1)`));
    return currentTxId(tx);
  });
}

describe("currentTxId", () => {
  test("returns BigInt-parseable xid8 decimal text", async () => {
    await DatabaseDriver.get().ready();
    const token = await writeTxCapturingToken();
    expect(token).toMatch(/^\d+$/);
    expect(BigInt(token) > 0n).toBe(true);
  });

  test("is strictly increasing across sequential write transactions", async () => {
    const first = await writeTxCapturingToken();
    const second = await writeTxCapturingToken();
    expect(BigInt(second) > BigInt(first)).toBe(true);
  });

  test("committed write's token compares < a subsequent snapshot xmin (Rule A↔B)", async () => {
    const token = await writeTxCapturingToken();
    // The snapshot watermark exactly as captureWatermark
    // (plugins/database/plugins/live-state-snapshot/server/internal/persist.ts)
    // captures it before a loader read. Our write committed before this capture,
    // so its xid can no longer be in progress: xmin (lowest in-progress xid,
    // else next-to-assign) must lie strictly above it — the strict `>` that lets
    // a snapshot DENY an op per Rule B. Assumes no concurrent transaction older
    // than our commit is still open cluster-wide at capture time (long-lived
    // transactions pin xmin — the plan's accepted "delayed, never unsound"
    // residue; in this suite nothing holds transactions open).
    const res = await db.execute<{ xmin: string }>(
      sql.raw(`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin`),
    );
    const xmin = res.rows[0]?.xmin;
    if (xmin === undefined) {
      throw new Error("pg_snapshot_xmin returned no row");
    }
    expect(BigInt(token) < BigInt(xmin)).toBe(true);
  });
});
