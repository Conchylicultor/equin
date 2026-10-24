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
import { EventEmitter } from "node:events";
import net from "node:net";
import type { ClientBase, Pool, PoolClient } from "pg";
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
import { createDbClient, createDbPool, type DbClient } from "./client";
import {
  QueryDeadlineExceededError,
  queryDeadlineSink,
  withQueryDeadline,
  type QueryDeadlineEvent,
} from "./deadline";
import { startBlackHoleProxy, type BlackHoleProxy } from "../testing";
import {
  AbandonedClientHold,
  abandonClient,
  assertPgPoolInternals,
} from "./abandon";

// The connection deadline against a REAL Postgres, through a black-hole proxy
// (../testing/black-hole-proxy.ts): a TCP server in front of the cluster whose forwarding
// can be switched off, so bytes are swallowed rather than refused — the
// vanished-bytes incident the deadline guards
// (research/2026-09-11-global-live-updates-frozen-by-stray-fd-close.md).
//
// No throwaway database: every statement here is table-free (`select 1`,
// `pg_sleep`), so the suite talks to the always-present `postgres` maintenance
// database. The upstream is the embedded cluster's socket, named by
// `database/embedded` (not `readDatabaseConfig` from `database/core`: that edge
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
  // Tears down every proxied socket, abandoned ones included: each abandoned pg
  // client now gets a real `end` + `error` from its socket. Without the
  // abandon's no-op listeners that `error` is unhandled and fails this run.
  await proxy.close();
  await new Promise((r) => setTimeout(r, 50));
});

interface PgPoolInternals {
  _clients: ClientBase[];
  _idle: { client: ClientBase; timeoutId: unknown }[];
}

function internals(pool: Pool): PgPoolInternals {
  return pool as unknown as PgPoolInternals;
}

/** The client's socket: an abandoned client's must never be destroyed (closed). */
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
  /** Clients whose `end()` was called — an abandoned client must never be one. */
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
  // Every test releases what it checked out and abandoned clients are no longer
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

// ---------------------------------------------------------------------------
// pg-pool internals pin
// ---------------------------------------------------------------------------

describe("pg-pool internals (pinned: a pg-pool upgrade that moves them fails here)", () => {
  it("abandonClient detaches checked-out and idle clients without ending them", async () => {
    const t = createTestPool({ max: 1, idleTimeoutMillis: 100 });
    const { pool } = t;
    assertPgPoolInternals(pool);
    const hold = new AbandonedClientHold(8);

    // A checked-out client is in `_clients`, not `_idle`.
    const a = await pool.connect();
    expect(internals(pool)._clients).toContain(a);
    expect(pool.totalCount).toBe(1);

    // The pool is full, so the next checkout queues.
    const queued = pool.connect();
    await sleep(10);
    expect(pool.waitingCount).toBe(1);

    // Abandoning the checked-out client frees its place, and the queued checkout
    // gets a FRESH client right away (the pulse) — not the abandoned one.
    abandonClient(pool, a, "jobs-runner", hold);
    expect(internals(pool)._clients).not.toContain(a);
    const b = await queued;
    expect(b).not.toBe(a);

    // A released client sits in `_idle` with its idle timer.
    b.release();
    expect(internals(pool)._idle.map((item) => item.client)).toEqual([b]);
    expect(internals(pool)._idle[0]!.timeoutId).toBeDefined();

    // Abandoning an idle client removes it and cancels that timer: past the
    // 100 ms idle timeout, pg-pool never ended it.
    abandonClient(pool, b, "jobs-runner", hold);
    expect(pool.idleCount).toBe(0);
    expect(pool.totalCount).toBe(0);
    await sleep(250);
    expect(t.ended.has(a)).toBe(false);
    expect(t.ended.has(b)).toBe(false);

    // Neither has the pool's error listener any more; the abandon's no-op one
    // absorbs a late socket error instead of crashing the process.
    expect(() => a.emit("error", new Error("late socket error"))).not.toThrow();
    expect(() => b.emit("error", new Error("late socket error"))).not.toThrow();
    expect(hold.size).toBe(2);
  });
});

describe("AbandonedClientHold cap", () => {
  it("holds up to the cap, then detaches without holding and emits abandon-cap", () => {
    const clients = [1, 2, 3].map(
      () => new EventEmitter() as unknown as PoolClient,
    );
    let pulses = 0;
    const fakePool = {
      _clients: [...clients],
      _idle: [],
      _pulseQueue: () => {
        pulses++;
      },
    } as unknown as Pool;
    const hold = new AbandonedClientHold(2);

    abandonClient(fakePool, clients[0]!, "admin", hold);
    abandonClient(fakePool, clients[1]!, "admin", hold);
    expect(events).toEqual([]);

    abandonClient(fakePool, clients[2]!, "admin", hold);
    expect(events).toEqual([
      {
        kind: "abandon-cap",
        at: expect.any(Number),
        pool: "admin",
        abandoned: 3,
        cap: 2,
      },
    ]);
    expect(hold.size).toBe(2);
    expect(hold.abandoned).toBe(3);
    expect(internals(fakePool)._clients).toEqual([]);
    expect(pulses).toBe(3);

    // Idempotent: a second abandon of the same client does nothing.
    abandonClient(fakePool, clients[2]!, "admin", hold);
    expect(events.length).toBe(1);
    expect(hold.abandoned).toBe(3);
    expect(() => clients[2]!.emit("error", new Error("late"))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The query deadline
// ---------------------------------------------------------------------------

describe("query deadline on a pooled client", () => {
  it("rejects a lost query, abandons its connection, and the next query gets a fresh one", async () => {
    const t = createTestPool();
    const { pool } = t;
    await warm(pool);
    const warmed = t.acquired.at(-1)!;

    proxy.setForwarding(false);
    const client = await pool.connect();
    expect(client).toBe(warmed);
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

    // The client is gone from the pool — not ended, not idle, not counted —
    // and its socket was never closed.
    expect(internals(pool)._clients).not.toContain(client);
    expect(internals(pool)._idle.map((i) => i.client)).not.toContain(client);
    expect(pool.totalCount).toBe(0);
    expect(t.ended.has(client)).toBe(false);
    expect(socketOf(client).destroyed).toBe(false);
    expect(() =>
      client.emit("error", new Error("late socket error")),
    ).not.toThrow();

    // A later call on the lost client fails at once with the same error, and
    // releasing it — even as broken — does nothing.
    expect(await rejectionOf(client.query("select 1"))).toBe(err);
    expect(() => client.release(true)).not.toThrow();
    expect(t.ended.has(client)).toBe(false);
    expect(socketOf(client).destroyed).toBe(false);
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

    // pg-pool answers a failed query with `release(err)` — a destroy — which
    // the lost client turned into a no-op.
    expect(t.acquired.at(-1)).toBe(warmed);
    expect(pool.totalCount).toBe(0);
    expect(t.ended.has(warmed)).toBe(false);
    expect(socketOf(warmed).destroyed).toBe(false);
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

  it("abandons a slow-but-alive query too, and its late reply never returns it to the pool", async () => {
    const t = createTestPool();
    const { pool } = t;

    const err = asDeadlineError(
      await rejectionOf(pool.query("select pg_sleep(0.5)")),
    );
    expect(err.deadlineMs).toBe(DEADLINE_MS);
    const slow = t.acquired.at(-1)!;

    // The reply lands ~200 ms after the deadline: it resolves a call already
    // settled, and pg-pool never sees the client again.
    await sleep(400);
    expect(internals(pool)._clients).not.toContain(slow);
    expect(internals(pool)._idle.map((i) => i.client)).not.toContain(slow);
    expect(t.ended.has(slow)).toBe(false);
    expect(events.length).toBe(1);
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
    expect(internals(pool)._clients).not.toContain(leased);
    expect(t.ended.has(leased)).toBe(false);

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
  it("fails a pooled checkout whose connection never answers, and the pool forgets the client without closing it", async () => {
    const t = createTestPool({ max: 1 });
    const { pool } = t;

    proxy.setForwarding(false);
    const first = rejectionOf(pool.connect());
    const queued = rejectionOf(pool.connect()); // waits: the pool is full
    await sleep(20);
    expect(pool.waitingCount).toBe(1);
    const connecting = internals(pool)._clients[0]!;
    expect(connecting).toBeDefined();

    const err = asDeadlineError(await first);
    expect(err.pool).toBe("jobs-runner");
    expect(err.phase).toBe("connect");
    expect(err.sql).toBe("[connect]");
    expect(err.deadlineMs).toBe(DEADLINE_MS);

    // pg-pool dropped it from `_clients`; nothing ended it or closed its socket;
    // the pool's idle `error` listener (whose firing ends a client) was taken
    // off again, leaving only the abandon's no-op one.
    expect(internals(pool)._clients).not.toContain(connecting);
    expect(socketOf(connecting).destroyed).toBe(false);
    expect(connecting.listeners("error")).toHaveLength(1);
    expect(() =>
      connecting.emit("error", new Error("late socket error")),
    ).not.toThrow();
    expect(socketOf(connecting).destroyed).toBe(false);

    // The waiting checkout got a new client (the pulse), which is black-holed
    // too: it fails on its own bound rather than waiting forever.
    const queuedErr = asDeadlineError(await queued);
    expect(queuedErr).not.toBe(err);
    expect(queuedErr.phase).toBe("connect");
    expect(pool.totalCount).toBe(0);
    expect(events.map((e) => e.kind === "deadline" && e.phase)).toEqual([
      "connect",
      "connect",
    ]);

    // Recovery.
    proxy.setForwarding(true);
    const client = await pool.connect();
    await client.query("select 1");
    client.release();
    expect(t.ended.size).toBe(0);
  });

  it("fails a standalone client's connect; later calls fail at once, end() closes nothing", async () => {
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

    expect(await rejectionOf(client.query("LISTEN x"))).toBe(err);
    await client.end();
    expect(socketOf(client).destroyed).toBe(false);
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
