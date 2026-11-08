import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import net from "node:net";
import { Client, type ClientBase, type Pool, type PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import {
  PG_PORT,
  PG_SOCKET_DIR,
  PG_USER,
} from "@plugins/database/plugins/embedded/server";
import {
  currentEntryLabel,
  installSpanContextRuntime,
  recordEntrySpan,
  type EntryContext,
} from "@plugins/infra/plugins/runtime-profiler/core";
import {
  declareRuntimeNamespace,
  runtimeNamespace,
} from "@plugins/infra/plugins/runtime-identity/core";
import { resetRuntimeNamespaceForTest } from "@plugins/infra/plugins/runtime-identity/core/testing";
import type { ServerErrorReport } from "@plugins/framework/plugins/server-core/core";
import { setServerErrorHandler } from "@plugins/framework/plugins/server-core/core/testing";
import { createDbClient, createDbPool, type DbClient } from "./client";
import {
  QueryDeadlineExceededError,
  queryDeadlineSink,
  withQueryDeadline,
  type QueryDeadlineEvent,
} from "./deadline";
import { startBlackHoleProxy, type BlackHoleProxy } from "../testing";

// The connection deadline against a REAL Postgres, through a black-hole proxy
// (../testing/black-hole-proxy.ts): a TCP server in front of the cluster whose forwarding
// can be switched off, so bytes are swallowed rather than refused — the
// vanished-bytes incident the deadline guards
// (research/2026-09-11-global-live-updates-frozen-by-stray-fd-close.md).
//
// No throwaway database: every statement here is table-free (`select 1`,
// `pg_sleep`), so the suite talks to the always-present `postgres` maintenance
// database. The upstream is the embedded cluster's socket, named by
// `database/embedded` (not `readDatabaseConfigSync` from `database/core`: that edge
// would close a plugin cycle, since `database` imports this plugin).
//
// Requires the running embedded cluster (./equin build). Unreachable
// cluster ⇒ the first connect throws loudly, never a silent skip.

const DEADLINE_MS = 300;

// The origin the deadline names is ambient: inject the recorder's
// AsyncLocalStorage runtime exactly as runtime-profiler/server does at boot.
const als = new AsyncLocalStorage<EntryContext>();
installSpanContextRuntime({
  run: (ctx, fn) => als.run(ctx, fn),
  current: () => als.getStore(),
});

function upstreamTarget(): net.NetConnectOpts {
  return { path: `${PG_SOCKET_DIR}/.s.PGSQL.${PG_PORT}` };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let proxy: BlackHoleProxy;

beforeAll(async () => {
  proxy = await startBlackHoleProxy(upstreamTarget());
});

afterAll(async () => {
  await proxy.close();
  await new Promise((r) => setTimeout(r, 50));
});

/** The client's socket: a lost client's is destroyed (closed) by the deadline. */
function socketOf(client: ClientBase): net.Socket {
  return (client as unknown as { connection: { stream: net.Socket } })
    .connection.stream;
}

function proxiedConnectionString(): string {
  return `postgres://${PG_USER}@127.0.0.1:${proxy.port}/postgres`;
}

interface TestPool {
  pool: Pool;
  /** Every checkout, in order (a pooled client appears once per checkout). */
  acquired: PoolClient[];
  /** Clients whose `end()` was called — pg-pool's `_remove` ends a dropped client. */
  ended: Set<ClientBase>;
}

const pools: Pool[] = [];

function createTestPool(
  opts: { idleTimeoutMillis?: number; max?: number; deadlineMs?: number } = {},
): TestPool {
  const pool = createDbPool({
    name: "jobs-runner",
    connectionString: proxiedConnectionString(),
    max: opts.max ?? 4,
    idleTimeoutMillis: opts.idleTimeoutMillis ?? 0,
    deadlineMs: opts.deadlineMs ?? DEADLINE_MS,
  });
  const t: TestPool = { pool, acquired: [], ended: new Set() };
  pool.on("connect", (client) => {
    // `PoolClient`'s type omits `end`; the runtime object is a pg Client.
    const raw = client as unknown as { end: (...args: unknown[]) => unknown };
    const end = raw.end.bind(raw);
    raw.end = (...args) => {
      t.ended.add(client);
      return end(...args);
    };
  });
  pool.on("acquire", (client) => t.acquired.push(client));
  pools.push(pool);
  return t;
}

const events: QueryDeadlineEvent[] = [];

beforeEach(() => {
  events.length = 0;
  queryDeadlineSink.register((event) => events.push(event));
});

afterEach(async () => {
  queryDeadlineSink.register(null);
  proxy.setForwarding(true);
  // Every test releases what it checked out, and a lost client is no longer
  // the pool's, so end() never waits on a lost statement.
  for (const pool of pools.splice(0)) await pool.end();
});

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject");
}

function asDeadlineError(err: unknown): QueryDeadlineExceededError {
  expect(err).toBeInstanceOf(QueryDeadlineExceededError);
  return err as QueryDeadlineExceededError;
}

/** Warm one pooled connection so the next checkout costs nothing. */
async function warm(pool: Pool): Promise<void> {
  await pool.query("select 1");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200 && !(await cond()); i++) await sleep(10);
  expect(await cond()).toBe(true);
}

/** The server session behind a connection (asked while it still answers). */
async function backendPidOf(client: ClientBase): Promise<number> {
  const { rows } = await client.query<{ pid: number }>(
    "select pg_backend_pid() as pid",
  );
  return rows[0]!.pid;
}

// The server's view, read on a direct session that bypasses the proxy: what a
// lost connection left behind on the server is the whole point of closing it.
let observer: Client;
beforeAll(async () => {
  observer = new Client({
    host: PG_SOCKET_DIR,
    port: PG_PORT,
    user: PG_USER,
    database: "postgres",
  });
  await observer.connect();
});
afterAll(async () => {
  await observer.end();
});

async function sessionAlive(pid: number): Promise<boolean> {
  const { rows } = await observer.query<{ n: number }>(
    "select count(*)::int as n from pg_stat_activity where pid = $1",
    [pid],
  );
  return rows[0]!.n > 0;
}

// ---------------------------------------------------------------------------
// The query deadline
// ---------------------------------------------------------------------------

describe("query deadline on a pooled client", () => {
  it("rejects a lost query, closes its connection, and the next query gets a fresh one", async () => {
    const t = createTestPool();
    const { pool } = t;
    await warm(pool);
    const warmed = t.acquired.at(-1)!;

    const client = await pool.connect();
    expect(client).toBe(warmed);
    const pid = await backendPidOf(client);
    proxy.setForwarding(false);
    const t0 = performance.now();
    const err = asDeadlineError(
      await rejectionOf(
        recordEntrySpan("job", "tasks.maybe-launch", () =>
          client.query("select 42 as lost"),
        ),
      ),
    );
    const wall = performance.now() - t0;

    expect(wall).toBeGreaterThanOrEqual(DEADLINE_MS - 5);
    expect(wall).toBeLessThan(DEADLINE_MS + 250);
    expect(err.pool).toBe("jobs-runner");
    expect(err.phase).toBe("query");
    expect(err.sql).toBe("select 42 as lost");
    expect(err.deadlineMs).toBe(DEADLINE_MS);
    expect(err.elapsedMs).toBeGreaterThanOrEqual(DEADLINE_MS - 5);
    expect(err.origin).toBe("tasks.maybe-launch");
    expect(err.reason).toBeNull();
    // No `.code`: the app pool's 40P01/40001 retry must never re-run it.
    expect((err as unknown as { code?: unknown }).code).toBeUndefined();

    // The client is gone from the pool — handed back as broken, so pg-pool
    // dropped and ended it — its socket is closed, and so its server session
    // ended (the proxy passes the close on, as PgBouncer does).
    expect(pool.totalCount).toBe(0);
    expect(pool.idleCount).toBe(0);
    expect(t.ended.has(client)).toBe(true);
    expect(socketOf(client).destroyed).toBe(true);
    await until(async () => !(await sessionAlive(pid)));
    expect(() =>
      client.emit("error", new Error("late socket error")),
    ).not.toThrow();

    // A later call on the lost client fails at once with the same error, and
    // the holder's own release — even as broken — does nothing more.
    expect(await rejectionOf(client.query("select 1"))).toBe(err);
    expect(() => client.release(true)).not.toThrow();
    expect(pool.totalCount).toBe(0);

    // Exactly one emission, carrying the same facts as the error.
    expect(events).toEqual([
      {
        kind: "deadline",
        at: expect.any(Number),
        pool: "jobs-runner",
        phase: "query",
        sql: "select 42 as lost",
        elapsedMs: err.elapsedMs,
        deadlineMs: DEADLINE_MS,
        origin: "tasks.maybe-launch",
        reason: null,
        // A warmed connection, outside any transaction, alone in flight.
        transaction: "idle",
        inFlight: [],
        inFlightCount: 0,
      },
    ]);

    // Recovery: the pool builds a replacement and the next query succeeds.
    proxy.setForwarding(true);
    const res = await pool.query<{ ok: number }>("select 1 as ok");
    expect(res.rows).toEqual([{ ok: 1 }]);
    expect(t.acquired.at(-1)).not.toBe(client);
    expect(pool.totalCount).toBe(1);

    await sleep(DEADLINE_MS);
    expect(events.length).toBe(1);
  });

  it("bounds pg-pool's own pool.query (the callback form underneath)", async () => {
    const t = createTestPool();
    const { pool } = t;
    await warm(pool);
    const warmed = t.acquired.at(-1)!;

    proxy.setForwarding(false);
    const err = asDeadlineError(
      await rejectionOf(pool.query("select 7 as lost")),
    );
    expect(err.sql).toBe("select 7 as lost");
    expect(err.phase).toBe("query");

    // The deadline handed the client back as broken; pg-pool's own
    // `release(err)` after the failed query then did nothing more (no
    // double-release throw).
    expect(t.acquired.at(-1)).toBe(warmed);
    expect(pool.totalCount).toBe(0);
    expect(t.ended.has(warmed)).toBe(true);
    expect(socketOf(warmed).destroyed).toBe(true);
    expect(events.length).toBe(1);
  });

  it("fails a statement queued behind the lost one at once, with the same error", async () => {
    const { pool } = createTestPool();
    await warm(pool);
    const client = await pool.connect();

    proxy.setForwarding(false);
    const first = rejectionOf(client.query("select 1 as lost"));
    await sleep(150);
    const t1 = performance.now();
    const second = rejectionOf(client.query("select 2 as queued"));

    const err = asDeadlineError(await first);
    // The queued statement would have had its own full bound; it fails with
    // the first one's error as soon as the connection is lost instead.
    expect(await second).toBe(err);
    expect(performance.now() - t1).toBeLessThan(DEADLINE_MS - 50);
    expect(events.length).toBe(1);
    client.release();
  });

  it("closes a slow-but-alive query's connection too, and nothing returns it to the pool", async () => {
    const t = createTestPool();
    const { pool } = t;

    const err = asDeadlineError(
      await rejectionOf(pool.query("select pg_sleep(0.5)")),
    );
    expect(err.deadlineMs).toBe(DEADLINE_MS);
    const slow = t.acquired.at(-1)!;
    expect(socketOf(slow).destroyed).toBe(true);

    // Past when the reply would have landed: pg-pool never sees the client again.
    await sleep(400);
    expect(pool.totalCount).toBe(0);
    expect(pool.idleCount).toBe(0);
    expect(t.ended.has(slow)).toBe(true);
    expect(events.length).toBe(1);
  });

  it("a connection lost inside a transaction is closed: its session ends and its locks are released", async () => {
    // The 2026-11-03 shape: a transaction holding a lock, its next statement
    // lost. Abandoned, the session stayed `idle in transaction` with the lock
    // for five hours; closed, Postgres rolls it back at once.
    const t = createTestPool();
    const { pool } = t;
    const client = await pool.connect();
    const pid = await backendPidOf(client);
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(4242)");
    expect(await sessionAlive(pid)).toBe(true);

    proxy.setForwarding(false);
    const err = asDeadlineError(
      await rejectionOf(client.query("select 2 as lost_in_tx")),
    );
    expect(events).toMatchObject([{ kind: "deadline", transaction: "open" }]);
    expect(err.sql).toBe("select 2 as lost_in_tx");

    await until(async () => !(await sessionAlive(pid)));
    const { rows } = await observer.query<{ got: boolean }>(
      "select pg_try_advisory_lock(4242) as got",
    );
    expect(rows[0]!.got).toBe(true);
    await observer.query("select pg_advisory_unlock(4242)");

    client.release();
    expect(pool.totalCount).toBe(0);
  });

  it("a client released with its call still pending is dropped from the pool when the call is lost", async () => {
    // A holder bug — release() while its statement is in flight — leaves the
    // client idle in the pool. Lost, it must not be handed out again.
    const { pool } = createTestPool({ max: 1 });
    await warm(pool);
    const client = await pool.connect();
    proxy.setForwarding(false);
    const lost = rejectionOf(client.query("select 1 as pending"));
    client.release();
    expect(pool.idleCount).toBe(1);

    asDeadlineError(await lost);
    await until(() => pool.totalCount === 0);
    expect(pool.idleCount).toBe(0);
    expect(socketOf(client).destroyed).toBe(true);

    proxy.setForwarding(true);
    const next = await pool.connect();
    expect(next).not.toBe(client);
    next.release();
  });

  it("an unexpected error on a closed lost client is reported once, never swallowed or fatal", async () => {
    const reports: ServerErrorReport[] = [];
    setServerErrorHandler((r) => reports.push(r));
    try {
      const client = createDbClient({
        name: "change-feed",
        connectionString: proxiedConnectionString(),
        deadlineMs: DEADLINE_MS,
      });
      proxy.setForwarding(false);
      asDeadlineError(await rejectionOf(client.connect()));
      expect(reports).toEqual([]);
      client.emit("error", new Error("late surprise"));
      client.emit("error", new Error("and another"));
      expect(reports).toHaveLength(1);
      expect(reports[0]!.message).toBe(
        "[db] pool=change-feed: error on a connection closed after a missed deadline: late surprise",
      );
    } finally {
      setServerErrorHandler(() => {});
    }
  });

  it("a lost background-lease checkout: the holder's wrapped release after the loss does nothing more", async () => {
    // A holder that wraps `release` (the app pool's background lease does) —
    // the deadline returns the client through pg-pool's own release, and the
    // holder's wrapper, called later, neither throws nor returns it twice.
    const t = createTestPool();
    const { pool } = t;
    const client = await pool.connect();
    const inner = client.release.bind(client);
    let wrapperCalls = 0;
    client.release = (err?: Error | boolean) => {
      wrapperCalls++;
      inner(err);
    };
    proxy.setForwarding(false);
    asDeadlineError(await rejectionOf(client.query("select 1 as lost")));
    expect(pool.totalCount).toBe(0);
    expect(socketOf(client).destroyed).toBe(true);
    expect(() => client.release()).not.toThrow();
    expect(wrapperCalls).toBe(0);

    proxy.setForwarding(true);
    expect((await pool.query<{ ok: number }>("select 1 as ok")).rows).toEqual([
      { ok: 1 },
    ]);
  });

  it("a transaction that hangs rejects once; its ROLLBACK fails at once with the same error", async () => {
    const t = createTestPool();
    const { pool } = t;
    const tdb = drizzle(pool);

    const err = asDeadlineError(
      await rejectionOf(
        recordEntrySpan("job", "test.tx-job", () =>
          tdb.transaction(async (tx) => {
            await tx.execute(sql`select 1`);
            proxy.setForwarding(false);
            await tx.execute(sql`select 2 as lost_in_tx`);
          }),
        ),
      ),
    );

    expect(err.sql).toBe("select 2 as lost_in_tx");
    expect(err.origin).toBe("test.tx-job");
    // drizzle's ROLLBACK on the lost client rejected at once with the SAME
    // error (no second deadline, no second emission), then its argless
    // release() was absorbed.
    expect(events.length).toBe(1);
    const leased = t.acquired.at(-1)!;
    expect(t.ended.has(leased)).toBe(true);
    expect(socketOf(leased).destroyed).toBe(true);

    // The pool recovers: the next transaction runs on a new client.
    proxy.setForwarding(true);
    const rows = await tdb.transaction(async (tx) =>
      tx.execute(sql`select 3 as ok`),
    );
    expect(rows.rows).toEqual([{ ok: 3 }]);
    expect(t.acquired.at(-1)).not.toBe(leased);
    expect(events.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The connect deadline
// ---------------------------------------------------------------------------

describe("connect deadline", () => {
  it("fails a pooled checkout whose connection never answers, and the pool drops the closed client", async () => {
    const t = createTestPool({ max: 1 });
    const { pool } = t;
    // pg-pool builds each client as `new pool.Client(options)`: record them.
    const built: ClientBase[] = [];
    const host = pool as unknown as {
      Client: new (...args: unknown[]) => ClientBase;
    };
    const Base = host.Client;
    host.Client = class extends Base {
      constructor(...args: unknown[]) {
        super(...args);
        built.push(this);
      }
    };

    proxy.setForwarding(false);
    const first = rejectionOf(pool.connect());
    const queued = rejectionOf(pool.connect()); // waits: the pool is full
    await sleep(20);
    expect(pool.waitingCount).toBe(1);
    expect(pool.totalCount).toBe(1);
    const connecting = built[0]!;

    const err = asDeadlineError(await first);
    expect(err.pool).toBe("jobs-runner");
    expect(err.phase).toBe("connect");
    expect(err.sql).toBe("[connect]");
    expect(err.deadlineMs).toBe(DEADLINE_MS);

    // pg-pool's connect callback dropped it; the deadline closed its socket,
    // and a late socket error on it is absorbed.
    expect(socketOf(connecting).destroyed).toBe(true);
    expect(() =>
      connecting.emit("error", new Error("late socket error")),
    ).not.toThrow();

    // The waiting checkout got a new client (the pulse), which is black-holed
    // too: it fails on its own bound rather than waiting forever.
    const queuedErr = asDeadlineError(await queued);
    expect(queuedErr).not.toBe(err);
    expect(queuedErr.phase).toBe("connect");
    expect(pool.totalCount).toBe(0);
    expect(events.map((e) => e.phase)).toEqual(["connect", "connect"]);

    // Recovery.
    proxy.setForwarding(true);
    const client = await pool.connect();
    await client.query("select 1");
    client.release();
    expect(t.ended.size).toBe(0);
  });

  it("fails a standalone client's connect and closes it; later calls fail at once", async () => {
    const client: DbClient = createDbClient({
      name: "change-feed",
      connectionString: proxiedConnectionString(),
      deadlineMs: DEADLINE_MS,
    });

    proxy.setForwarding(false);
    const t0 = performance.now();
    const err = asDeadlineError(
      await rejectionOf(
        recordEntrySpan("job", "change-feed.listen", () => client.connect()),
      ),
    );
    expect(performance.now() - t0).toBeLessThan(DEADLINE_MS + 250);
    expect(err.pool).toBe("change-feed");
    expect(err.phase).toBe("connect");
    expect(err.origin).toBe("change-feed.listen");
    expect(client.lostError).toBe(err);

    expect(socketOf(client).destroyed).toBe(true);
    expect(await rejectionOf(client.query("LISTEN x"))).toBe(err);
    await client.end();
    expect(() =>
      client.emit("error", new Error("late socket error")),
    ).not.toThrow();
    expect(events).toEqual([
      {
        kind: "deadline",
        at: expect.any(Number),
        pool: "change-feed",
        phase: "connect",
        sql: "[connect]",
        elapsedMs: err.elapsedMs,
        deadlineMs: DEADLINE_MS,
        origin: "change-feed.listen",
        reason: null,
        // A connection being opened has had no reply: no state to read.
        transaction: null,
        inFlight: [],
        inFlightCount: 0,
      },
    ]);
  });

  it("a connect that answers in time is untouched", async () => {
    const client = createDbClient({
      name: "change-feed",
      connectionString: proxiedConnectionString(),
      deadlineMs: DEADLINE_MS,
    });
    await client.connect();
    const res = await client.query("select 1 as ok");
    expect(res.rows).toEqual([{ ok: 1 }]);
    await sleep(DEADLINE_MS + 50);
    expect(client.lostError).toBeNull();
    await client.end();
    expect(events).toEqual([]);
  });
});

describe("withQueryDeadline", () => {
  it("extends the bound for its scope", async () => {
    const { pool } = createTestPool();
    const res = await withQueryDeadline(
      { ms: 3_000, reason: "test: long" },
      () => pool.query<{ done: string }>("select pg_sleep(0.5)::text as done"),
    );
    expect(res.rows.length).toBe(1);
    expect(events).toEqual([]);
  });

  it("names its bound and reason on an expiry", async () => {
    const { pool } = createTestPool();
    await warm(pool);
    proxy.setForwarding(false);
    const err = asDeadlineError(
      await rejectionOf(
        withQueryDeadline({ ms: 150, reason: "test: short" }, () =>
          pool.query("select 1"),
        ),
      ),
    );
    expect(err.deadlineMs).toBe(150);
    expect(err.reason).toBe("test: short");
    expect(err.origin).toBeNull(); // context-less, like boot DDL
    expect(events).toMatchObject([
      { kind: "deadline", deadlineMs: 150, reason: "test: short" },
    ]);
  });

  it("a queued pool.query keeps its caller's bound and origin, not the releaser's", async () => {
    // A default bound the 1 s statement fits in: only the caller's 300 ms scope
    // can fail it.
    const { pool } = createTestPool({ max: 1, deadlineMs: 5_000 });
    const held = await pool.connect();

    const queued = rejectionOf(
      recordEntrySpan("job", "boot.ddl-caller", () =>
        withQueryDeadline({ ms: DEADLINE_MS, reason: "test: queued" }, () =>
          pool.query("select pg_sleep(1)"),
        ),
      ),
    );
    await sleep(20);
    expect(pool.waitingCount).toBe(1);

    // pg-pool hands the queued checkout its connection from inside this
    // release(), i.e. in the releaser's async context.
    await recordEntrySpan("http", "GET /releaser", async () => {
      held.release();
    });

    const err = asDeadlineError(await queued);
    expect(err.deadlineMs).toBe(DEADLINE_MS);
    expect(err.reason).toBe("test: queued");
    expect(err.origin).toBe("boot.ddl-caller");
  });

  it("a queued checkout runs in its caller's context, in both connect forms", async () => {
    const { pool } = createTestPool({ max: 1 });
    const held = await pool.connect();

    const viaCallback = new Promise<string | undefined>((resolve, reject) => {
      void recordEntrySpan("job", "listen.caller", async () => {
        pool.connect((err, _client, done) => {
          if (err) return reject(err);
          const label = currentEntryLabel();
          done();
          resolve(label);
        });
      });
    });
    await sleep(20);
    await recordEntrySpan("http", "GET /releaser", async () => {
      held.release();
    });
    expect(await viaCallback).toBe("listen.caller");

    const again = await pool.connect();
    const viaPromise = recordEntrySpan("job", "await.caller", async () => {
      const client = await pool.connect();
      const label = currentEntryLabel();
      client.release();
      return label;
    });
    await sleep(20);
    await recordEntrySpan("http", "GET /releaser", async () => {
      again.release();
    });
    expect(await viaPromise).toBe("await.caller");
  });

  it("rejects a non-positive bound", () => {
    expect(() =>
      withQueryDeadline({ ms: 0, reason: "x" }, async () => 1),
    ).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Connection errors (a socket that breaks, as opposed to one that goes silent)
// ---------------------------------------------------------------------------

describe("connection errors on a pooled client", () => {
  const reports: ServerErrorReport[] = [];

  beforeEach(() => {
    reports.length = 0;
    setServerErrorHandler((r) => reports.push(r));
  });
  afterEach(() => {
    setServerErrorHandler(() => {});
  });

  async function backendPid(client: PoolClient): Promise<number> {
    const { rows } = await client.query<{ pid: number }>(
      "select pg_backend_pid() as pid",
    );
    return rows[0]!.pid;
  }

  /** Kill a server session from another connection. */
  async function terminate(pid: number): Promise<void> {
    await createTestPool().pool.query("select pg_terminate_backend($1)", [pid]);
  }

  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !cond(); i++) await sleep(10);
    expect(cond()).toBe(true);
  }

  it("carries its own error and connect listeners, so a library handed the pool installs none", () => {
    const { pool } = createTestPool();
    expect(pool.listenerCount("error")).toBeGreaterThan(0);
    expect(pool.listenerCount("connect")).toBeGreaterThan(0);
  });

  it("reports an idle client's error once, and the pool drops it without crashing", async () => {
    const { pool } = createTestPool();
    const client = await pool.connect();
    const pid = await backendPid(client);
    client.release();
    expect(pool.idleCount).toBe(1);
    await terminate(pid);
    await until(() => reports.length > 0 && pool.totalCount === 0);
    await sleep(50);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ errorType: "DbConnectionError" });
    expect(reports[0]!.message).toStartWith(
      "[db] pool=jobs-runner: connection error: ",
    );
    expect(await pool.query("select 1 as one")).toMatchObject({
      rows: [{ one: 1 }],
    });
  });

  it("reports a checked-out client's error; its next statement rejects and release drops it", async () => {
    const { pool } = createTestPool();
    const client = await pool.connect();
    await terminate(await backendPid(client));
    await until(() => reports.length > 0);
    expect(reports).toHaveLength(1);
    await rejectionOf(client.query("select 1"));
    client.release();
    expect(pool.totalCount).toBe(0);
  });
});

describe("in a process with no runtime namespace (a CLI)", () => {
  it("still rejects the caller, and writes the [deadline] line to stderr instead of crashing", async () => {
    const namespace = runtimeNamespace();
    const written: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    resetRuntimeNamespaceForTest();
    try {
      const client = createDbClient({
        name: "admin-short-lived",
        connectionString: proxiedConnectionString(),
        deadlineMs: DEADLINE_MS,
      });
      proxy.setForwarding(false);
      const err = asDeadlineError(await rejectionOf(client.connect()));
      expect(err.pool).toBe("admin-short-lived");
      expect(err.phase).toBe("connect");
    } finally {
      declareRuntimeNamespace(namespace);
      process.stderr.write = realWrite;
    }
    expect(
      written.filter((line) =>
        line.startsWith("[deadline] pool=admin-short-lived"),
      ),
    ).toHaveLength(1);
    expect(events).toMatchObject([
      { kind: "deadline", pool: "admin-short-lived" },
    ]);
  });
  it("in a backend, leaves the line to the sink handler (nothing on stderr)", async () => {
    const written: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const client = createDbClient({
        name: "change-feed",
        connectionString: proxiedConnectionString(),
        deadlineMs: DEADLINE_MS,
      });
      proxy.setForwarding(false);
      asDeadlineError(await rejectionOf(client.connect()));
    } finally {
      process.stderr.write = realWrite;
    }
    expect(written.filter((line) => line.startsWith("[deadline]"))).toEqual([]);
    expect(events).toMatchObject([{ kind: "deadline", pool: "change-feed" }]);
  });
});

// ---------------------------------------------------------------------------
// What a missed deadline knows beyond the call itself
// ---------------------------------------------------------------------------

describe("what a missed deadline reports it was part of", () => {
  it("names the lost connection's transaction state and every other call in flight", async () => {
    const connect = async () => {
      const client = createDbClient({
        name: "events-test",
        connectionString: proxiedConnectionString(),
        deadlineMs: DEADLINE_MS,
      });
      await client.connect();
      return client;
    };
    const head = await connect();
    const waiter = await connect();
    // The head is inside an open transaction when its next statement is lost —
    // the 2026-11-03 shape: a lost connection holding row locks.
    await head.query("begin");
    await head.query("select 1");

    proxy.setForwarding(false);
    const waiterLost = rejectionOf(
      recordEntrySpan("job", "usage:sync waiter", () =>
        waiter.query("select 2 as waiter"),
      ),
    );
    await sleep(50);
    const headLost = rejectionOf(
      recordEntrySpan("job", "usage:sync head", () =>
        head.query("select 3 as head"),
      ),
    );
    asDeadlineError(await waiterLost);
    asDeadlineError(await headLost);

    const deadlines = events;
    expect(deadlines.map((e) => e.origin)).toEqual([
      "usage:sync waiter",
      "usage:sync head",
    ]);
    const [first, second] = deadlines;

    // The waiter was lost first, outside any transaction; the head's statement
    // was then in flight, inside its open transaction.
    expect(first!.transaction).toBe("idle");
    expect(first!.inFlightCount).toBe(1);
    expect(first!.inFlight).toEqual([
      {
        pool: "events-test",
        phase: "query",
        sql: "select 3 as head",
        origin: "usage:sync head",
        ageMs: expect.any(Number),
        transaction: "open",
      },
    ]);
    expect(first!.inFlight[0]!.ageMs).toBeGreaterThanOrEqual(DEADLINE_MS - 100);

    // The head: sent inside an open transaction, nothing left in flight (the
    // waiter's call settled at its own deadline).
    expect(second!.transaction).toBe("open");
    expect(second!.inFlight).toEqual([]);
    expect(second!.inFlightCount).toBe(0);
  });
});
