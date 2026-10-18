import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient } from "pg";
import {
  createDbClient,
  queryDeadlineSink,
  type DbClient,
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
  extractReadTablesFromSql,
  installQueryWrapper,
  POOL_MAX,
  quotedRelationsIn,
  RESERVED_INTERACTIVE,
  setKnownRelations,
} from "./client";

// The quoted half of the read-set capture, with no relation set at all: what a
// raw-SQL compiler checks its rendered text against (a quoted CTE name would
// land in every read-set the query is captured under).
describe("quotedRelationsIn", () => {
  afterEach(() => setKnownRelations(null));

  it("returns the quoted FROM / JOIN names, deduped, in order of first appearance", () => {
    const sql =
      'select * from "tasks" t left join "attempts" a on a.task_id = t.id inner join "tasks" t2 on true';
    expect(quotedRelationsIn(sql)).toEqual(["tasks", "attempts"]);
  });

  it("ignores unquoted names whatever relation set is installed", () => {
    setKnownRelations(new Set(["tasks", "__agg"]));
    const sql =
      'with __agg as (select 1) select * from tasks join __agg on true join "pushes" p on true';
    expect(quotedRelationsIn(sql)).toEqual(["pushes"]);
  });

  it("reports a quoted CTE name — the spelling a raw shape must avoid", () => {
    const sql = 'with "__agg" as (select 1) select * from "__agg"';
    expect(quotedRelationsIn(sql)).toEqual(["__agg"]);
  });

  it("drops write targets and IS DISTINCT FROM operands, like the capture", () => {
    const sql =
      'delete from "notifications" where "a" is distinct from "b" and exists (select 1 from "reports")';
    expect(quotedRelationsIn(sql)).toEqual(["reports"]);
  });

  it("agrees with the capture's quoted branch when no relation set is installed", () => {
    setKnownRelations(null);
    const sql =
      'select * from "tasks" join attempts on true join "pushes" on true, lateral (select 1) x';
    expect(quotedRelationsIn(sql)).toEqual(extractReadTablesFromSql(sql));
  });
});

// A loader's read-set contains only tables it READS (FROM / JOIN). Write targets
// (INSERT INTO / UPDATE / DELETE) must never appear — they are foreign
// observability leaks captured under a loader's ambient context, never a genuine
// read dependency. These tests pin that invariant so a future regex change that
// re-admits write targets is caught here rather than as read-set attribution
// noise in the Debug → Read-set pane.
describe("extractReadTablesFromSql", () => {
  it("captures FROM and JOIN targets, dedups repeats, order-insensitive", () => {
    const sql =
      'select * from "attempts_v" a join "conversations_v" c on c.attempt_id = a.id join "conversations_v" c2 on c2.id = c.parent';
    expect(extractReadTablesFromSql(sql).sort()).toEqual(
      ["attempts_v", "conversations_v"].sort(),
    );
  });

  it("ignores INSERT INTO write targets", () => {
    const sql =
      'insert into "notifications" (id, title) values ($1, $2) on conflict (id) do update set title = $2';
    expect(extractReadTablesFromSql(sql)).toEqual([]);
  });

  it("ignores UPDATE write targets", () => {
    const sql = 'update "notifications" set read = true where id = $1';
    expect(extractReadTablesFromSql(sql)).toEqual([]);
  });

  it("ignores DELETE FROM write targets", () => {
    const sql = 'delete from "notifications" where id = $1';
    expect(extractReadTablesFromSql(sql)).toEqual([]);
  });

  it("captures reads inside a subquery", () => {
    const sql =
      'select * from "tasks_v" where id in (select task_id from "attempts_v")';
    expect(extractReadTablesFromSql(sql).sort()).toEqual(
      ["attempts_v", "tasks_v"].sort(),
    );
  });

  // The set of relations that really exist is a module-level singleton, installed
  // once at boot. Every case below that installs one must put it back, or the
  // last one installed would still be in force for the lane-partition and
  // transaction-lease tests further down this file.
  afterEach(() => {
    setKnownRelations(null);
  });

  // A hand-written sql`` template names its tables the way SQL is normally
  // written — unquoted. Before this, such a read recorded NOTHING, so the
  // resource served stale data with no error and no log: the chord trainer's
  // progress panel stopped updating after every saved round. These are the real
  // table names from that incident.
  it("captures unquoted FROM and JOIN targets that name real relations", () => {
    setKnownRelations(new Set(["chord_answers", "chord_rounds"]));
    const sql =
      "select count(*) from chord_answers a join chord_rounds r on r.id = a.round_id";
    expect(extractReadTablesFromSql(sql).sort()).toEqual(
      ["chord_answers", "chord_rounds"].sort(),
    );
  });

  // Widening to unquoted names means anything that can follow FROM is now a
  // candidate — CTE names, subquery aliases, correlation names. Keeping only the
  // ones that name a real relation is what stops those phantoms from reaching the
  // Debug → Read-set pane, which would otherwise flag every resource as a silent
  // FULL and destroy the one surface that spots this class of bug.
  it("drops an unquoted candidate that names no real relation", () => {
    setKnownRelations(new Set(["chord_answers"]));
    const sql =
      "with recent as (select 1) select * from recent join chord_answers on true";
    expect(extractReadTablesFromSql(sql)).toEqual(["chord_answers"]);
  });

  // The compiled SQL of a live loader: the page sidebar's doc-order walk
  // (plugins/page/plugins/editor/server/internal/page-doc-order.ts). Its
  // recursive term reads `FROM up u` — the CTE it is defining — and its stop
  // condition uses `IS DISTINCT FROM`. Only the real table may come out.
  it("captures only the real table from a recursive CTE, not its own alias", () => {
    setKnownRelations(new Set(["page_blocks", "pages"]));
    const sql = `
      WITH RECURSIVE up AS (
        SELECT b.id AS page_row_id, b.page_id, b.parent_id AS cursor,
               ARRAY[b.rank::text] AS path
        FROM "page_blocks" b
        WHERE b.type = $1 AND b.deleted_at IS NULL
        UNION ALL
        SELECT u.page_row_id, u.page_id, p.parent_id, p.rank::text || u.path
        FROM up u
        JOIN "page_blocks" p ON p.id = u.cursor AND p.deleted_at IS NULL
        WHERE u.cursor IS NOT NULL
          AND u.cursor IS DISTINCT FROM u.page_id
          AND array_length(u.path, 1) < 64
      )
      SELECT page_row_id, path FROM up WHERE cursor IS NULL OR cursor = page_id
    `;
    expect(extractReadTablesFromSql(sql)).toEqual(["page_blocks"]);
  });

  // `IS DISTINCT FROM` is Postgres's null-safe inequality operator, followed by an
  // expression — never a table. It matches `\bfrom\s+<identifier>` all the same,
  // and there are seven sites in this repo, one of them inside a live loader. The
  // known set here deliberately contains the identifiers that follow the operator,
  // so this case can only pass because the keyword is guarded — never by accident
  // because the relation filter happened to drop them.
  it("treats IS DISTINCT FROM as an operator, not a FROM clause", () => {
    setKnownRelations(new Set(["page_blocks", "u", "page_id"]));
    expect(
      extractReadTablesFromSql(
        "select 1 from page_blocks where cursor IS DISTINCT FROM page_id",
      ),
    ).toEqual(["page_blocks"]);
    expect(
      extractReadTablesFromSql(
        "select 1 where u.cursor IS DISTINCT FROM u.page_id",
      ),
    ).toEqual([]);
  });

  // What follows FROM is not always a name: it can be a set-returning function,
  // a LATERAL subquery, or a plain derived table. All three appear in the chord
  // progress loader this fix came from; none of them is a dependency.
  it("captures nothing from a function call, a LATERAL, or a derived table", () => {
    setKnownRelations(new Set(["chord_answers", "chord_rounds"]));
    const sql = `
      SELECT t.token, a.correct
      FROM unnest($1::text[]) WITH ORDINALITY AS t(token, ord)
      CROSS JOIN LATERAL (
        SELECT correct FROM (SELECT true AS correct) rows_only
      ) a
      ORDER BY t.ord
    `;
    expect(extractReadTablesFromSql(sql)).toEqual([]);
  });

  // The write-target exclusions above are pinned in their quoted spelling; they
  // must hold in the unquoted one too, or widening the match would start
  // recording a loader's incidental writes as read dependencies.
  it("ignores unquoted write targets (DELETE FROM / INSERT INTO / UPDATE)", () => {
    setKnownRelations(new Set(["chord_answers", "notifications"]));
    expect(
      extractReadTablesFromSql(
        "delete from chord_answers where answered_at < $1",
      ),
    ).toEqual([]);
    expect(
      extractReadTablesFromSql(
        "insert into notifications (id, title) values ($1, $2)",
      ),
    ).toEqual([]);
    expect(
      extractReadTablesFromSql(
        "update notifications set read = true where id = $1",
      ),
    ).toEqual([]);
  });

  // A single statement mixes both spellings whenever a raw sql`` template
  // interpolates a drizzle table object (which renders quoted) beside a
  // hand-written name. Both are dependencies, and naming one table twice in two
  // spellings must still yield one entry.
  it("captures quoted and unquoted names in one statement, deduped", () => {
    setKnownRelations(new Set(["chord_answers", "chord_rounds"]));
    const sql =
      'select * from chord_answers a join "chord_rounds" r on r.id = a.round_id ' +
      'join "chord_answers" b on b.round_id = r.id where b.token in (select token from chord_answers)';
    expect(extractReadTablesFromSql(sql).sort()).toEqual(
      ["chord_answers", "chord_rounds"].sort(),
    );
  });

  // The change-feed names a changed table by its bare `TG_TABLE_NAME`, so a
  // `public.`-qualified read must land on the same key or the write would never
  // route to the resource. A read in ANY other schema is dropped whole: the feed
  // structurally excludes those schemas, so recording one would add a dependency
  // that can never fire — which the Debug pane then reports as a silent FULL.
  // The jobs list below is the real loader that reads outside `public`; it drives
  // its own notify() and must contribute nothing here.
  it("reduces a public-qualified name and drops every other schema", () => {
    setKnownRelations(new Set(["tasks", "attempts"]));
    expect(
      extractReadTablesFromSql(
        "select * from public.tasks t join public.attempts a on a.task_id = t.id",
      ).sort(),
    ).toEqual(["attempts", "tasks"].sort());

    const jobsList = `
      SELECT j.id::text AS id, t.identifier AS task_identifier, j.payload
        FROM graphile_worker._private_jobs j
        JOIN graphile_worker._private_tasks t ON t.id = j.task_id
   LEFT JOIN graphile_worker._private_job_queues q ON q.id = j.job_queue_id
       ORDER BY j.run_at DESC
    `;
    expect(extractReadTablesFromSql(jobsList)).toEqual([]);
  });

  // `FROM ONLY tasks` excludes a partitioned table's children. Without the strip
  // it would record the keyword `ONLY` and miss the table entirely — the exact
  // silent miss this change exists to remove, so it is pinned before anyone
  // writes one.
  it("strips a leading ONLY and keeps the table behind it", () => {
    setKnownRelations(new Set(["tasks"]));
    expect(extractReadTablesFromSql("select * from only tasks")).toEqual([
      "tasks",
    ]);
  });

  // Two windows have no relation set: the boot window before it is loaded, and
  // the central runtime, which never touches this pool. In both, behaviour must
  // be byte-identical to what it was before unquoted names were matched at all —
  // quoted captured, unquoted dropped. A loader that ran in that window heals on
  // its next full recompute, because the recorded read-set replaces rather than
  // unions.
  it("drops every unquoted name when no relation set is installed", () => {
    setKnownRelations(null);
    const sql =
      'select * from chord_answers a join "chord_rounds" r on r.id = a.round_id';
    expect(extractReadTablesFromSql(sql)).toEqual(["chord_rounds"]);
  });
});

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
function unconnectedClient(deadlineMs = 60_000): DbClient {
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
  // module-load assertion in client.ts is the production guard; this names the
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
