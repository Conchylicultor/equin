import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { openListenSession } from "@plugins/database/plugins/connection/server";
import type { DatabaseDriverImpl } from "@plugins/database/server";
import { createChangeFeedListener } from "./listener";
import type { FeedChange } from "./route-change";
import { BARRIER_CHANNEL } from "./txn-end";

// A feed cut's barrier (`feedCut`, `listener.barrier`) on a real LISTEN
// session: it resolves only once every change that reached the socket before
// it has been ROUTED — including a transaction the burst router still holds
// for its end marker — and it never resolves without a session to prove it on.

let testDb: TestDb;

const listenOnTestDb: DatabaseDriverImpl["listen"] = (channels, handlers) =>
  openListenSession({
    name: "change-feed",
    connectionString: testDb.connectionString,
    channels,
    handlers,
    endFailed: (err) => {
      throw err;
    },
  });

beforeAll(async () => {
  testDb = await createTestDb({ prefix: "cf_barrier" });
});

afterAll(async () => {
  await testDb.drop();
});

function listener(routed: FeedChange[]) {
  return createChangeFeedListener({
    listen: listenOnTestDb,
    route: (c) => routed.push(c),
    coveredTables: () => ["demo"],
    livenessIntervalMs: 60_000,
    // A held transaction is never released by its deadline during a test.
    txnEndDeadlineMs: 60_000,
  });
}

// A barrier's outcome as a value: its rejection observed where it lands.
const outcome = (p: Promise<void>): Promise<string> =>
  p.then(
    () => "resolved",
    (err: Error) => err.message,
  );

// The listener installs its session a beat after Postgres shows the LISTEN:
// a barrier asked before then is refused, so wait for one to be accepted.
async function established(l: ReturnType<typeof listener>): Promise<void> {
  const start = Date.now();
  let n = 0;
  while (Date.now() - start < 5000) {
    const probe = l.barrier(`probe-${n++}`, 1);
    const ok = await probe.then(
      () => true,
      (err: Error) => !err.message.includes("no LISTEN session"),
    );
    if (ok) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("the listener never established its session");
}

describe("the feed cut's barrier", () => {
  test("with no session it is refused at once", async () => {
    const l = listener([]);
    expect(await outcome(l.barrier("t0", 1000))).toContain("no LISTEN session");
  });

  test("a barrier waiting when the listener stops is refused", async () => {
    const l = listener([]);
    l.start();
    await established(l);
    // Settled into a value now, so the rejection stop() causes is observed
    // where it lands rather than left unhandled while stop() runs.
    const settled = outcome(l.barrier("t3", 5000));
    await l.stop();
    expect(await settled).toContain("listener stopped");
  });

  test("it resolves only after a held transaction's changes were routed", async () => {
    const routed: FeedChange[] = [];
    const l = listener(routed);
    l.start();
    try {
      await established(l);
      // A change carrying an xid, with no end marker: the burst router holds it.
      await testDb.db.execute(
        sql`SELECT pg_notify('live_state', ${JSON.stringify({ t: "demo", op: "U", ids: ["a"], x: "555" })})`,
      );
      const arrived = l.barrier("t1", 5000);
      await testDb.db.execute(sql`SELECT pg_notify(${BARRIER_CHANNEL}, 't1')`);
      await arrived;
      expect(routed.map((c) => c.ids)).toEqual([["a"]]);
    } finally {
      await l.stop();
    }
  });

  test("another token does not answer it; past its deadline it is refused", async () => {
    const l = listener([]);
    l.start();
    try {
      await established(l);
      const waiting = outcome(l.barrier("t2", 200));
      await testDb.db.execute(
        sql`SELECT pg_notify(${BARRIER_CHANNEL}, 'other')`,
      );
      expect(await waiting).toContain("did not arrive");
    } finally {
      await l.stop();
    }
  });
});
