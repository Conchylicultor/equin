import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { createChangeFeedListener } from "./listener";
import type { FeedChange } from "./route-change";
import type { TxnEndProblem } from "./burst";
import { rebuildTriggers } from "./triggers";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { openListenSession } from "@plugins/database/plugins/connection/server";
import type { DatabaseDriverImpl } from "@plugins/database/server";

// Real-DB listener suite: a throwaway database on the running cluster, a real raw
// LISTEN client, and real `pg_notify` delivery over that socket. The listener's
// contract is precisely "LISTEN live_state → parseLiveStatePayload → route", so we
// drive it at that boundary with `pg_notify('live_state', <payload>)` — the exact
// wire the STATEMENT trigger emits — rather than installing triggers (that is
// change-feed's trigger concern, exercised at every boot's rebuildTriggers, not the
// listener's). This keeps the test a faithful unit of the listener while creating
// no imperative table. Each test drives a FRESH listener (isolated per-instance
// closure state) with a recording `route` spy.
//
// Requires a running Postgres cluster (started by ./singularity build). If the
// cluster is unreachable, createTestDb() throws loudly with an actionable message
// rather than silently skipping.

let testDb: TestDb;

// The desktop driver's LISTEN session (`DatabaseDriver.listen`), on the
// throwaway database's direct connection.
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

// Large liveness interval everywhere so the reconnect WATCHDOG never fires during
// a test — reconnect is driven only by the `error`/`end` handler (test 3), never
// by the timer.
const QUIET_LIVENESS_MS = 60_000;

// A payload exactly as the STATEMENT trigger's live_state_notify() emits it.
function notifyPayload(
  table: string,
  op: "I" | "U" | "D",
  ids: string[] | null,
): string {
  return JSON.stringify({ t: table, op, ids });
}

// Fire a NOTIFY on the live_state channel from a pooled (autocommit) connection —
// delivered to the listener's dedicated LISTEN socket on commit, same database.
async function emitNotify(payload: string): Promise<void> {
  await testDb.db.execute(sql`SELECT pg_notify('live_state', ${payload})`);
}

// Bounded polling helper. Never a fixed long sleep: loops on a predicate (sync or
// async) with short steps and fails LOUDLY on timeout.
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
}

// The listener's LISTEN backend is idle after running `LISTEN live_state`, so its
// pg_stat_activity.query row is exactly that text. Polling for it is a precise,
// data-free readiness signal (and the same handle test 3 terminates).
async function waitForListen(timeoutMs = 5000): Promise<void> {
  await waitFor(
    async () => {
      const res = await testDb.db.execute<{ present: number }>(
        sql`SELECT 1 AS present FROM pg_stat_activity
            WHERE datname = current_database()
              AND query LIKE 'LISTEN live_state%'
              AND pid <> pg_backend_pid()`,
      );
      return res.rows.length > 0;
    },
    "LISTEN live_state backend to appear",
    timeoutMs,
  );
}

function sameIds(
  a: readonly string[] | null,
  b: readonly string[] | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function findChange(
  routed: FeedChange[],
  table: string,
  op: FeedChange["op"],
  ids: string[] | null,
): FeedChange | undefined {
  return routed.find(
    (c) => c.table === table && c.op === op && sameIds(c.ids, ids),
  );
}

beforeAll(async () => {
  testDb = await createTestDb({ prefix: "cf_test" });
});

afterAll(async () => {
  await testDb.drop();
});

describe("change-feed listener (real DB + real NOTIFY)", () => {
  test("delivers INSERT and UPDATE NOTIFYs to the route spy", async () => {
    const routed: FeedChange[] = [];
    const listener = createChangeFeedListener({
      listen: listenOnTestDb,
      route: (c) => routed.push(c),
      coveredTables: () => ["demo"],
      livenessIntervalMs: QUIET_LIVENESS_MS,
    });
    listener.start();
    try {
      await waitForListen();

      await emitNotify(notifyPayload("demo", "I", ["a"]));
      await waitFor(
        () => findChange(routed, "demo", "I", ["a"]) !== undefined,
        "INSERT change routed",
      );

      await emitNotify(notifyPayload("demo", "U", ["a"]));
      await waitFor(
        () => findChange(routed, "demo", "U", ["a"]) !== undefined,
        "UPDATE change routed",
      );
    } finally {
      await listener.stop();
    }
  });

  test("a routed payload reaches the route with its layout; a malformed one routes unscoped, never skipped", async () => {
    const routed: FeedChange[] = [];
    const listener = createChangeFeedListener({
      listen: listenOnTestDb,
      route: (c) => routed.push(c),
      coveredTables: () => ["side"],
      livenessIntervalMs: QUIET_LIVENESS_MS,
    });
    listener.start();
    try {
      await waitForListen();
      // As live_state_notify_routed() emits it: the row-wise key layout, the
      // unchanged gate columns.
      await emitNotify(
        JSON.stringify({
          t: "side",
          op: "U",
          ids: ["s1"],
          k: { c: ["host"], r: [["h1"], ["h2"]] },
          u: ["host"],
          x: "7",
        }),
      );
      // Its transaction's end marker: the change was held until it came.
      await testDb.db.execute(
        sql`SELECT pg_notify('live_state_end', ${JSON.stringify({ x: "7", n: 1 })})`,
      );
      await waitFor(
        () => findChange(routed, "side", "U", ["s1"]) !== undefined,
        "routed change delivered",
      );
      const scoped = findChange(routed, "side", "U", ["s1"])!;
      expect(scoped.keys).toEqual({ host: ["h1", "h2"] });
      expect(scoped.unchanged).toEqual(["host"]);
      expect(scoped.xid).toBe("7");

      // A layout that does not parse: the table and op are known, so the
      // change goes out unscoped (FULL for its readers) — as catch-up replays it.
      await emitNotify(
        JSON.stringify({
          t: "side",
          op: "D",
          ids: ["s2"],
          k: { c: ["host"], r: [["h1", "extra"]] },
        }),
      );
      await waitFor(
        () => findChange(routed, "side", "D", null) !== undefined,
        "malformed-layout change routed unscoped",
      );
      const unscoped = findChange(routed, "side", "D", null)!;
      expect(unscoped.keys).toBeNull();
      expect(unscoped.unchanged).toBeNull();
    } finally {
      await listener.stop();
    }
  });

  test("first connect does NOT fullSweep", async () => {
    const routed: FeedChange[] = [];
    const listener = createChangeFeedListener({
      listen: listenOnTestDb,
      route: (c) => routed.push(c),
      coveredTables: () => ["demo"],
      livenessIntervalMs: QUIET_LIVENESS_MS,
    });
    listener.start();
    try {
      await waitForListen();
      // A fullSweep on first connect would emit {demo, U, ids:null} the moment
      // LISTEN establishes — with no data change. Assert no such synthetic FULL.
      expect(routed.filter((c) => c.ids === null)).toEqual([]);

      // Prove the listener is nonetheless live: a real scoped change still routes,
      // with a non-null id — not a FULL.
      await emitNotify(notifyPayload("demo", "I", ["b"]));
      await waitFor(
        () => findChange(routed, "demo", "I", ["b"]) !== undefined,
        "real scoped change routed after first connect",
      );
      expect(routed.filter((c) => c.ids === null)).toEqual([]);
    } finally {
      await listener.stop();
    }
  });

  test("reconnect fires a fullSweep", async () => {
    // Deterministic reconnect: swap the backoff timer for an immediate one so the
    // capped-backoff delay never gates the test. The error/end handler still
    // drives the reconnect; only its delay is collapsed to 0.
    const fastSetTimeout = ((fn: () => void) =>
      globalThis.setTimeout(fn, 0)) as unknown as typeof setTimeout;

    const routed: FeedChange[] = [];
    const listener = createChangeFeedListener({
      listen: listenOnTestDb,
      route: (c) => routed.push(c),
      coveredTables: () => ["demo"],
      livenessIntervalMs: QUIET_LIVENESS_MS,
      setTimeoutFn: fastSetTimeout,
    });
    listener.start();
    try {
      await waitForListen();
      // Ignore anything that raced in before the drop; we only care about the
      // post-reconnect sweep.
      routed.length = 0;

      // Real socket drop: terminate the listener's LISTEN backend. Its client
      // emits `error`/`end` → scheduleReconnect → (fast) reconnect → LISTEN
      // re-established → fullSweep (firstConnect already flipped false).
      await testDb.db.execute(
        sql`SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND query LIKE 'LISTEN live_state%'
              AND pid <> pg_backend_pid()`,
      );

      await waitFor(
        () => findChange(routed, "demo", "U", null) !== undefined,
        "fullSweep FULL change after reconnect",
      );
    } finally {
      await listener.stop();
    }
  });

  test("malformed NOTIFY payload is skipped, listener survives", async () => {
    const routed: FeedChange[] = [];
    const listener = createChangeFeedListener({
      listen: listenOnTestDb,
      route: (c) => routed.push(c),
      coveredTables: () => ["demo"],
      livenessIntervalMs: QUIET_LIVENESS_MS,
    });
    listener.start();
    try {
      await waitForListen();

      // Emit a malformed payload, then a real change on the SAME connection.
      // NOTIFYs are ordered, so once the real change routes we know the malformed
      // one was already processed-and-skipped (parseLiveStatePayload → null).
      await emitNotify("not json");
      await emitNotify(notifyPayload("demo", "I", ["c"]));
      await waitFor(
        () => findChange(routed, "demo", "I", ["c"]) !== undefined,
        "real change routed after malformed payload",
      );

      // The malformed payload produced no routed entry — everything routed is a
      // well-formed FeedChange.
      expect(
        routed.every(
          (c) =>
            (c.op === "I" || c.op === "U" || c.op === "D") &&
            typeof c.table === "string",
        ),
      ).toBe(true);
    } finally {
      await listener.stop();
    }
  });

  test("stop() ends the LISTEN client and clears the liveness timer", async () => {
    const cleared: unknown[] = [];
    const recordingSetInterval = ((fn: () => void, ms?: number) =>
      globalThis.setInterval(fn, ms)) as unknown as typeof setInterval;
    const recordingClearInterval = ((id?: ReturnType<typeof setInterval>) => {
      cleared.push(id);
      globalThis.clearInterval(id);
    }) as unknown as typeof clearInterval;

    const routed: FeedChange[] = [];
    const listener = createChangeFeedListener({
      listen: listenOnTestDb,
      route: (c) => routed.push(c),
      coveredTables: () => ["demo"],
      livenessIntervalMs: QUIET_LIVENESS_MS,
      setIntervalFn: recordingSetInterval,
      clearIntervalFn: recordingClearInterval,
    });
    listener.start();
    await waitForListen();

    // Confirm live before stop.
    await emitNotify(notifyPayload("demo", "I", ["d"]));
    await waitFor(
      () => findChange(routed, "demo", "I", ["d"]) !== undefined,
      "change routed before stop",
    );

    await listener.stop();

    // Liveness timer was cleared exactly through the injected clearInterval.
    expect(cleared.length).toBeGreaterThan(0);

    // After stop the LISTEN client is ended: a subsequent NOTIFY does NOT route
    // (no session is LISTENing on this listener's now-closed socket).
    const routedAfterStop = routed.length;
    await emitNotify(notifyPayload("demo", "I", ["e"]));
    // Bounded window to let any (erroneous) delivery arrive, then assert none did.
    await new Promise((r) => setTimeout(r, 300));
    expect(routed.length).toBe(routedAfterStop);
  });
});

// The end-of-transaction marker, end to end: the real triggers (installed by
// `rebuildTriggers`, marker included) on a table of this suite, a real
// transaction, and the listener holding its changes until `live_state_end`.
describe("change-feed listener: the end-of-transaction marker (real triggers)", () => {
  const STATEMENTS = 2000;

  beforeAll(async () => {
    await testDb.db.execute(sql`CREATE TABLE burst_rows (id text PRIMARY KEY)`);
    await rebuildTriggers(
      testDb.db,
      { feedExempt: new Set(), optedOut: new Set(), produced: new Set() },
      [],
    );
  });

  // Each routed change counted into the burst — one synchronous run of the
  // router's flush — it was routed in.
  function burstRecorder() {
    const routed: FeedChange[] = [];
    const bursts: number[] = [];
    let inBurst = false;
    const route = (c: FeedChange): void => {
      routed.push(c);
      if (!inBurst) {
        inBurst = true;
        bursts.push(0);
        queueMicrotask(() => {
          inBurst = false;
        });
      }
      bursts[bursts.length - 1]!++;
    };
    return { routed, bursts, route };
  }

  test(`a ${STATEMENTS}-statement transaction routes as ONE burst, after its end marker`, async () => {
    // A raw second LISTEN client sees the marker itself.
    const watcher = new Client({ connectionString: testDb.connectionString });
    await watcher.connect();
    const ends: string[] = [];
    watcher.on("notification", (n) => {
      if (n.channel === "live_state_end" && n.payload) ends.push(n.payload);
    });
    await watcher.query("LISTEN live_state_end");

    const { routed, bursts, route } = burstRecorder();
    const problems: TxnEndProblem[] = [];
    const listener = createChangeFeedListener({
      listen: listenOnTestDb,
      route,
      report: (p) => problems.push(p),
      coveredTables: () => ["burst_rows"],
      livenessIntervalMs: QUIET_LIVENESS_MS,
    });
    listener.start();
    try {
      await waitForListen();
      // One transaction, one statement (one STATEMENT trigger, one NOTIFY,
      // one changelog row) per row: ~2000 NOTIFYs, far more than one socket
      // read carries.
      await testDb.db.execute(
        sql.raw(`DO $$ BEGIN
          FOR i IN 1..${STATEMENTS} LOOP
            INSERT INTO burst_rows VALUES ('r' || i);
          END LOOP;
        END $$`),
      );
      await waitFor(
        () => routed.length >= STATEMENTS && ends.length >= 1,
        "the transaction's changes routed and its end observed",
        15_000,
      );
      expect(routed).toHaveLength(STATEMENTS);
      expect(bursts).toEqual([STATEMENTS]);
      const xids = new Set(routed.map((c) => c.xid));
      expect(xids.size).toBe(1);
      expect(ends.map((e) => JSON.parse(e) as unknown)).toEqual([
        { x: [...xids][0], n: STATEMENTS },
      ]);
      expect(problems).toEqual([]);
    } finally {
      await listener.stop();
      await watcher.end();
    }
  });

  test("a transaction writing no feed table sends no marker, and its xid-less NOTIFY still routes", async () => {
    const { routed, route } = burstRecorder();
    const problems: TxnEndProblem[] = [];
    const listener = createChangeFeedListener({
      listen: listenOnTestDb,
      route,
      report: (p) => problems.push(p),
      coveredTables: () => ["burst_rows"],
      livenessIntervalMs: QUIET_LIVENESS_MS,
      // Short, so a change wrongly held would be reported within the test.
      txnEndDeadlineMs: 200,
    });
    listener.start();
    try {
      await waitForListen();
      await emitNotify(notifyPayload("burst_rows", "U", ["loose"]));
      await waitFor(
        () => findChange(routed, "burst_rows", "U", ["loose"]) !== undefined,
        "xid-less change routed",
      );
      await new Promise((r) => setTimeout(r, 400));
      expect(problems).toEqual([]);
    } finally {
      await listener.stop();
    }
  });

  test("a malformed end marker is skipped; its transaction is released by the deadline and reported, never dropped", async () => {
    const { routed, route } = burstRecorder();
    const problems: TxnEndProblem[] = [];
    const listener = createChangeFeedListener({
      listen: listenOnTestDb,
      route,
      report: (p) => problems.push(p),
      coveredTables: () => ["burst_rows"],
      livenessIntervalMs: QUIET_LIVENESS_MS,
      txnEndDeadlineMs: 200,
    });
    listener.start();
    try {
      await waitForListen();
      await emitNotify(
        JSON.stringify({ t: "burst_rows", op: "U", ids: ["m"], x: "77" }),
      );
      await testDb.db.execute(
        sql`SELECT pg_notify('live_state_end', ${JSON.stringify({ x: "77", n: "one" })})`,
      );
      await waitFor(
        () => findChange(routed, "burst_rows", "U", ["m"]) !== undefined,
        "held change released by the deadline",
      );
      expect(problems).toEqual([
        { kind: "txn-end-missing", xid: "77", held: 1, ms: 200 },
      ]);
    } finally {
      await listener.stop();
    }
  });
});
