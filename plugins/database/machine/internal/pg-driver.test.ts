import { beforeEach, describe, it, expect } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient } from "pg";
import {
  createDbClient,
  queryDeadlineSink,
} from "@plugins/database/plugins/connection/server";
import { QueryDeadlineExceededError } from "@plugins/database/plugins/connection/server/testing";
import {
  installBackgroundLaneRuntime,
  installLoaderReadSetSink,
  installSpanContextRuntime,
  readGateGauges,
  recordEntrySpan,
  resetRuntimeProfile,
  runInBackgroundLane,
  type EntryContext,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { recordLoaderReadSet } from "@plugins/framework/plugins/server-core/core";
import { getReadSetIndex } from "@plugins/framework/plugins/server-core/core/testing";
import {
  BACKGROUND_QUERY_MAX,
  BACKGROUND_TX_MAX,
  installQueryWrapper,
  POOL_MAX,
  RESERVED_INTERACTIVE,
} from "./pg-driver";

// ---------------------------------------------------------------------------
// The lane partition (origin-based DB gating).
//
// No database: the wrapper is installed onto a fake `pg.Pool`-shaped object
// whose queries block until the test releases them, so what is under test is the
// gating logic and nothing else. The origin class the wrapper reads is ambient,
// so the recorder's AsyncLocalStorage runtimes are injected here exactly the way
// runtime-profiler/server/internal/install.ts injects them at boot — the core
// stays Node-free, and `recordEntrySpan` chains nest for real.
// ---------------------------------------------------------------------------

const als = new AsyncLocalStorage<EntryContext>();
installSpanContextRuntime({
  run: (ctx, fn) => als.run(ctx, fn),
  current: () => als.getStore(),
});

const backgroundLaneAls = new AsyncLocalStorage<true>();
installBackgroundLaneRuntime({
  run: (fn) => backgroundLaneAls.run(true, fn),
  active: () => backgroundLaneAls.getStore() === true,
});

// …and the loader read-set lands in server-core's runtime-owned index, as wired
// at boot. It is runtime state, so `resetRuntimeProfile` leaves it alone: the
// read-set assertions below use keys only these tests' loaders write.
installLoaderReadSetSink(recordLoaderReadSet);

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A never-connected `DbClient` — the class every app-pool client is — so the
 * lease can subscribe to its lost signal. With no connection, a query issued
 * through its own `query` waits forever, and its deadline (`deadlineMs`) fires.
 */
function unconnectedClient(
  deadlineMs = 60_000,
): ReturnType<typeof createDbClient> {
  return createDbClient({
    name: "app",
    connectionString: "postgres://nobody@127.0.0.1:1/never",
    deadlineMs,
  });
}

/**
 * A `pg.Pool`-shaped object whose queries block until the test releases them.
 * `installQueryWrapper` binds `query`/`connect` off this object *before*
 * overriding them, so the wrapper's internal `origConnect` reaches the fake the
 * same way it reaches the real pool.
 */
function createFakePool() {
  const blocked: Deferred[] = [];
  let queriesInFlight = 0;
  let peakQueriesInFlight = 0;
  let clientReleases = 0;

  const fake = {
    // Only the callback form ever reaches `origQuery`; the promise form is
    // reimplemented by the wrapper on top of `connect` + `client.query`.
    query: () => {
      throw new Error("promise-form pool.query must not reach origQuery");
    },
    connect: (): Promise<PoolClient> => {
      const client = unconnectedClient();
      client.query = async () => {
        queriesInFlight++;
        peakQueriesInFlight = Math.max(peakQueriesInFlight, queriesInFlight);
        const gate = deferred();
        blocked.push(gate);
        await gate.promise;
        queriesInFlight--;
        return { rows: [] };
      };
      // pg-pool assigns `release` per checkout; so does this fake.
      client.release = () => {
        clientReleases++;
      };
      return Promise.resolve(client as unknown as PoolClient);
    },
  };

  const pool = fake as unknown as Pool;
  installQueryWrapper(pool);

  return {
    pool,
    /** Unblock every query issued so far. */
    releaseAll: () => {
      for (const gate of blocked.splice(0)) gate.resolve();
    },
    peakQueriesInFlight: () => peakQueriesInFlight,
    blockedCount: () => blocked.length,
    clientReleases: () => clientReleases,
  };
}

/** Let every already-scheduled microtask/timer continuation settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

function txGauge() {
  const gauge = readGateGauges()["background-tx-acquire"];
  if (!gauge) throw new Error("background-tx-acquire gauge is not registered");
  return gauge;
}

// `flush → push → loader` is the real background chain (a cascade recompute);
// `sub → loader` is the real interactive one (a human's cold pane load). Both
// bottom out in a `loader` entry — precisely why caller-kind gating could not
// tell them apart, and why the gate now reads the chain's ROOT.
function backgroundLoader<T>(fn: () => Promise<T>): Promise<T> {
  return recordEntrySpan("flush", "flushNotifies", () =>
    recordEntrySpan("push", "resource", () =>
      recordEntrySpan("loader", "resource", fn),
    ),
  );
}

function interactiveLoader<T>(fn: () => Promise<T>): Promise<T> {
  return recordEntrySpan("sub", "resource", () =>
    recordEntrySpan("loader", "resource", fn),
  );
}

/** Drain a fully-queued background lane without ever letting the peak rise. */
async function drain(fake: ReturnType<typeof createFakePool>): Promise<void> {
  while (fake.blockedCount() > 0) {
    fake.releaseAll();
    await settle();
  }
}

beforeEach(() => {
  resetRuntimeProfile();
});

describe("lane capacity invariant", () => {
  // If this fails the background lane can deadlock: a transaction pinning a
  // connection may wait forever for a query slot that can never free. The
  // module-load assertion in pg-driver.ts is the production guard; this names the
  // property it guards.
  it("keeps background holders under the pool minus the interactive floor", () => {
    expect(BACKGROUND_TX_MAX + BACKGROUND_QUERY_MAX).toBe(
      POOL_MAX - RESERVED_INTERACTIVE,
    );
  });

  it("exposes an occupancy gauge sized to each background gate's cap", () => {
    const gauges = readGateGauges();
    expect(gauges["background-acquire"]?.max).toBe(BACKGROUND_QUERY_MAX);
    expect(gauges["background-tx-acquire"]?.max).toBe(BACKGROUND_TX_MAX);
  });
});

describe("pool.query lane partition", () => {
  it("never runs more than BACKGROUND_QUERY_MAX background queries at once", async () => {
    const fake = createFakePool();
    const queries = Array.from({ length: BACKGROUND_QUERY_MAX * 3 }, () =>
      backgroundLoader(() => fake.pool.query("select 1")),
    );

    await settle();
    expect(fake.peakQueriesInFlight()).toBe(BACKGROUND_QUERY_MAX);

    await drain(fake);
    await Promise.all(queries);
    // Each release admits exactly one waiter, so the peak never rose while draining.
    expect(fake.peakQueriesInFlight()).toBe(BACKGROUND_QUERY_MAX);
  });

  it("gates a bare job entry (Gap C)", async () => {
    const fake = createFakePool();
    const queries = Array.from({ length: BACKGROUND_QUERY_MAX * 2 }, () =>
      recordEntrySpan("job", "mail.sync-tick", () =>
        fake.pool.query("select 1"),
      ),
    );

    await settle();
    expect(fake.peakQueriesInFlight()).toBe(BACKGROUND_QUERY_MAX);

    await drain(fake);
    await Promise.all(queries);
  });

  it("gates a flush entry's own direct queries", async () => {
    const fake = createFakePool();
    const queries = Array.from({ length: BACKGROUND_QUERY_MAX * 2 }, () =>
      recordEntrySpan("flush", "flushNotifies", () =>
        fake.pool.query("select 1"),
      ),
    );

    await settle();
    expect(fake.peakQueriesInFlight()).toBe(BACKGROUND_QUERY_MAX);

    await drain(fake);
    await Promise.all(queries);
  });

  it("never gates an interactive origin (Gap A)", async () => {
    const fake = createFakePool();
    const n = BACKGROUND_QUERY_MAX * 4;
    // A sub-origin loader (the human's cold pane load) and a bare http handler:
    // both must run wide open, well past the background cap.
    const queries = [
      ...Array.from({ length: n }, () =>
        interactiveLoader(() => fake.pool.query("select 1")),
      ),
      ...Array.from({ length: n }, () =>
        recordEntrySpan("http", "GET /x", () => fake.pool.query("select 1")),
      ),
    ];

    await settle();
    expect(fake.peakQueriesInFlight()).toBe(2 * n);

    fake.releaseAll();
    await Promise.all(queries);
  });

  it("never gates context-less queries (boot / migrations / warmPool)", async () => {
    const fake = createFakePool();
    const n = BACKGROUND_QUERY_MAX * 3;
    const queries = Array.from({ length: n }, () =>
      fake.pool.query("select 1"),
    );

    await settle();
    expect(fake.peakQueriesInFlight()).toBe(n);

    fake.releaseAll();
    await Promise.all(queries);
  });

  it("lets runInBackgroundLane override an interactive origin", async () => {
    const fake = createFakePool();
    const queries = Array.from({ length: BACKGROUND_QUERY_MAX * 2 }, () =>
      recordEntrySpan("http", "GET /x", () =>
        runInBackgroundLane(() => fake.pool.query("select 1")),
      ),
    );

    await settle();
    expect(fake.peakQueriesInFlight()).toBe(BACKGROUND_QUERY_MAX);

    await drain(fake);
    await Promise.all(queries);
  });

  // Regression: read-set capture is keyed on the CALLER kind, not the lane, and
  // must survive the switch from caller-kind gating to origin-class gating.
  it("records a loader-kind query's read-set in either lane", async () => {
    const fake = createFakePool();

    const interactive = interactiveLoader(() =>
      fake.pool.query('select * from "tasks" join "attempts" on true'),
    );
    const background = recordEntrySpan("flush", "flushNotifies", () =>
      recordEntrySpan("push", "bg-resource", () =>
        recordEntrySpan("loader", "bg-resource", () =>
          fake.pool.query('select * from "pushes"'),
        ),
      ),
    );

    await settle();
    fake.releaseAll();
    await Promise.all([interactive, background]);

    const index = getReadSetIndex();
    expect([...(index["resource"] ?? [])].sort()).toEqual([
      "attempts",
      "tasks",
    ]);
    expect([...(index["bg-resource"] ?? [])]).toEqual(["pushes"]);
  });
});

describe("pool.connect transaction lease (Gap B)", () => {
  it("holds a tx slot from checkout until release()", async () => {
    const fake = createFakePool();
    expect(txGauge().active).toBe(0);

    const client = await recordEntrySpan("job", "some.job", () =>
      fake.pool.connect(),
    );
    expect(txGauge().active).toBe(1);

    client.release();
    expect(txGauge().active).toBe(0);
  });

  it("frees the tx slot exactly once when release() is called twice", async () => {
    const fake = createFakePool();

    const a = await recordEntrySpan("job", "a", () => fake.pool.connect());
    const b = await recordEntrySpan("job", "b", () => fake.pool.connect());
    expect(txGauge().active).toBe(2);

    a.release();
    a.release(); // a caller bug — must not hand back a slot this lease never held
    expect(txGauge().active).toBe(1);
    // pg's own release still runs on both calls, so its double-release error (a
    // no-op on the fake) stays loud rather than being swallowed by the patch.
    expect(fake.clientReleases()).toBe(2);

    b.release();
    expect(txGauge().active).toBe(0);
  });

  it("queues background connects beyond BACKGROUND_TX_MAX until a slot frees", async () => {
    const fake = createFakePool();
    const clients: PoolClient[] = [];
    const pending = Array.from({ length: BACKGROUND_TX_MAX + 2 }, () =>
      runInBackgroundLane(() => fake.pool.connect()).then((c) => {
        clients.push(c);
      }),
    );

    await settle();
    expect(txGauge().active).toBe(BACKGROUND_TX_MAX);
    expect(txGauge().queued).toBe(2);
    expect(clients.length).toBe(BACKGROUND_TX_MAX);

    // Freeing one slot admits exactly one waiter.
    clients[0]!.release();
    await settle();
    expect(clients.length).toBe(BACKGROUND_TX_MAX + 1);

    clients[1]!.release();
    await settle();
    expect(clients.length).toBe(BACKGROUND_TX_MAX + 2);

    await Promise.all(pending);
    for (const c of clients.slice(2)) c.release();
    expect(txGauge().active).toBe(0);
    expect(txGauge().queued).toBe(0);
  });

  it("takes no tx slot for an interactive connect", async () => {
    const fake = createFakePool();
    const clients = await Promise.all(
      Array.from({ length: BACKGROUND_TX_MAX + 3 }, () =>
        recordEntrySpan("http", "POST /x", () => fake.pool.connect()),
      ),
    );

    expect(clients.length).toBe(BACKGROUND_TX_MAX + 3);
    expect(txGauge().active).toBe(0);
    for (const c of clients) c.release();
  });

  it("takes no tx slot for a context-less connect (awaitDbReady / warmPool)", async () => {
    const fake = createFakePool();
    const client = await fake.pool.connect();
    expect(txGauge().active).toBe(0);
    client.release();
  });

  // The query path checks out its connection through the ORIGINAL connect
  // (captured before the override), so a background query holds a query slot and
  // never a tx slot. Double-gating it would halve the background lane and open a
  // second hold-and-wait edge.
  it("does not consume a tx slot on the query path", async () => {
    const fake = createFakePool();
    const query = backgroundLoader(() => fake.pool.query("select 1"));

    await settle();
    expect(txGauge().active).toBe(0);

    fake.releaseAll();
    await query;
    expect(txGauge().active).toBe(0);
  });

  it("frees the tx slot when the leased client is lost to a deadline, and release() is then a no-op", async () => {
    queryDeadlineSink.register(() => {});
    let releases = 0;
    const lostClient = unconnectedClient(50);
    lostClient.release = () => {
      releases++;
    };
    const fake = {
      query: () => {
        throw new Error("unused");
      },
      connect: () => Promise.resolve(lostClient as unknown as PoolClient),
    } as unknown as Pool;
    installQueryWrapper(fake);

    const client = await recordEntrySpan("job", "j", () => fake.connect());
    expect(txGauge().active).toBe(1);

    // drizzle's `BEGIN` hanging: no `release()` ever comes from the holder, so
    // the slot must come back at expiry.
    let caught: unknown;
    try {
      await client.query("BEGIN");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QueryDeadlineExceededError);
    expect(txGauge().active).toBe(0);

    // A holder that does release later neither reaches pg-pool (the client is
    // abandoned) nor frees a second slot.
    client.release();
    expect(releases).toBe(0);
    expect(txGauge().active).toBe(0);
    queryDeadlineSink.register(null);
  });

  it("returns the tx slot when connect() itself throws", async () => {
    const boom = new Error("connect failed");
    const fake = {
      query: () => {
        throw new Error("unused");
      },
      connect: () => Promise.reject(boom),
    } as unknown as Pool;
    installQueryWrapper(fake);

    let caught: unknown;
    try {
      await recordEntrySpan("job", "j", () => fake.connect());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom); // the failure propagates unchanged

    // Slot must be free again — a leak here would wedge the background lane shut
    // after BACKGROUND_TX_MAX failed checkouts.
    expect(txGauge().active).toBe(0);
    expect(txGauge().queued).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Read-set capture across a checked-out client.
//
// `pool.connect()` hands back a raw pooled client, which is the path
// `db.transaction()` takes. Queries issued on it never reach the `pool.query`
// wrapper, so a loader reading inside a transaction used to record no tables at
// all — the same silent staleness as an unquoted name, differently spelled.
// Capture is keyed on the CALLER kind and not the lane, so the interactive and
// background checkout paths must both record.
// ---------------------------------------------------------------------------

describe("pool.connect read-set capture", () => {
  it("records a loader's read-set for a query on an interactive checked-out client", async () => {
    const fake = createFakePool();

    const done = interactiveLoader(async () => {
      const client = await fake.pool.connect();
      try {
        await client.query('select * from "tasks" join "attempts" on true');
      } finally {
        client.release();
      }
    });

    await settle();
    fake.releaseAll();
    await done;

    expect([...(getReadSetIndex()["resource"] ?? [])].sort()).toEqual([
      "attempts",
      "tasks",
    ]);
  });

  it("records a loader's read-set for a query on a background checked-out client", async () => {
    const fake = createFakePool();

    const done = recordEntrySpan("flush", "flushNotifies", () =>
      recordEntrySpan("push", "bg-resource", () =>
        recordEntrySpan("loader", "bg-resource", async () => {
          const client = await fake.pool.connect();
          try {
            await client.query('select * from "pushes"');
          } finally {
            client.release();
          }
        }),
      ),
    );

    await settle();
    fake.releaseAll();
    await done;

    expect([...(getReadSetIndex()["bg-resource"] ?? [])]).toEqual(["pushes"]);
    // The lease the background checkout took is handed back by the release
    // above; wrapping the client's `query` must not disturb that accounting.
    expect(txGauge().active).toBe(0);
  });

  // The gate is on the caller kind, not the lane and not the checkout path: a
  // mutation handler's transaction is not a resource's value dependency, and
  // recording it would attribute foreign writes to whatever loader happened to
  // be open.
  it("records nothing for a non-loader caller on a checked-out client", async () => {
    const fake = createFakePool();

    const done = recordEntrySpan("http", "POST /x", async () => {
      const client = await fake.pool.connect();
      try {
        await client.query('select * from "tasks"');
      } finally {
        client.release();
      }
    });

    await settle();
    fake.releaseAll();
    await done;

    expect(getReadSetIndex()["POST /x"]).toBeUndefined();
  });
});
