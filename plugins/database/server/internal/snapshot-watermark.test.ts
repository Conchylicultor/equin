import { describe, test, expect } from "bun:test";
import { sql } from "drizzle-orm";
import { db, DatabaseDriver } from "./driver";
import { snapshotWatermark } from "./snapshot-watermark";

// Real-DB invariant suite for the snapshot watermark: xid8 decimal text that is
// BigInt-parseable and monotonic non-decreasing across a committed write. Its
// comparability with the ack token is pinned beside `currentTxId`
// (./current-tx-id.test.ts). Runs against the plugin's OWN worktree DB for the
// reason given there (the db-test-fixture is a child plugin — a cycle); the only
// write is a session-scoped TEMP table (ON COMMIT DROP).

async function committedWrite(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql.raw(`CREATE TEMP TABLE watermark_probe (n int) ON COMMIT DROP`),
    );
    await tx.execute(sql.raw(`INSERT INTO watermark_probe VALUES (1)`));
  });
}

describe("snapshotWatermark", () => {
  test("returns BigInt-parseable xid8 decimal text", async () => {
    await DatabaseDriver.get().ready();
    const wm = await snapshotWatermark(db);
    expect(wm).toMatch(/^\d+$/);
    expect(BigInt(wm) >= 0n).toBe(true);
  });

  test("is monotonic non-decreasing across a committed write", async () => {
    const first = await snapshotWatermark(db);
    await committedWrite();
    const second = await snapshotWatermark(db);
    expect(BigInt(second) >= BigInt(first)).toBe(true);
  });

  test("reads inside a transaction on its executor", async () => {
    const wm = await db.transaction((tx) => snapshotWatermark(tx));
    expect(wm).toMatch(/^\d+$/);
  });
});
