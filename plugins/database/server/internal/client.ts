import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  retryUntil,
  exponential,
  withJitter,
} from "@plugins/packages/plugins/retry/core";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import {
  recordSpan,
  chargeWait,
  currentCallerKind,
  currentOriginClass,
  recordReadTables,
  registerGateGauge,
} from "@plugins/infra/plugins/runtime-profiler/core";
import {
  readDatabaseConfig,
  buildConnectionString,
} from "@plugins/database/core";
import {
  createDbPool,
  onClientLost,
  queryText,
} from "@plugins/database/plugins/connection/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";

// The worktree name is the worktree DB name — the one thing the worktree pool
// genuinely needs, and it is this process's RUNTIME namespace (`--namespace`
// from the gateway, or the namespace an exec child's spawner stated). The ask is
// deferred to first use (the lazy `pool()` build, triggered by the first real
// query/connection) rather than run at module load, so this module is
// import-safe: admin-only importers that never touch the worktree pool, and unit
// tests that inject a fake `db` and never issue a query, both import it without
// one. It is still loud and never silently defaulted — a real query in a process
// that declared no namespace throws here.

const config = readDatabaseConfig();
const conn = config.pgbouncer
  ? {
      host: config.pgbouncer.host,
      port: config.pgbouncer.port,
      user: config.connection.user,
    }
  : {
      host: process.env.PGHOST ?? config.connection.host,
      port: Number(process.env.PGPORT ?? config.connection.port),
      user: process.env.PGUSER ?? config.connection.user,
    };

export const POOL_MAX = 16;

// The concurrency gates, at the only place the scarce resource is consumed.
//
// Of the pool's `max` connections, RESERVED_INTERACTIVE are always kept free for
// interactive work; the rest is the ceiling for background work. The partition
// is by ORIGIN CLASS — the lane of the outermost entry that triggered the query
// (`currentOriginClass()`), not the kind of the innermost one. Inside a resource
// load the innermost kind is `loader` regardless of *why* the load runs, so a
// caller-kind gate cannot tell a human's cold sub-ack load from a cascade
// recompute and queues the human behind hundreds of machine recomputes. Origin
// class can. See research/2026-07-09-global-interactive-lane-under-load.md.
//
// Gating at the query (rather than around whole loader bodies) means an
// in-memory loader that issues no query never waits, and a query holds a slot
// only for its own duration — the gate measures the real scarce thing, held
// connections, so cheap loaders stop being head-of-line-blocked behind DB work.
// See research/2026-06-19-global-live-state-unified-read-path-v2.md (Task 2) and
// research/2026-06-15-global-live-state-cascade-contention.md.
//
// TWO background gates, not one, and the split is a deadlock proof rather than a
// tuning knob. A background transaction (`pool.connect()` → `client.query`, the
// path drizzle's `db.transaction()` takes) holds a pool connection for its whole
// life and may `await` a plain `pool.query` inside its callback. Under ONE shared
// background gate, N transactions each holding a slot while awaiting a slot for
// their inner query deadlock the background lane permanently — the classic
// hold-and-wait cycle. Under two, the wait-for graph is acyclic by construction:
//
//     bg-tx → bg-query → pool connection → {interactive, boot}
//
// and the terminal holders always complete. Concretely: bg-tx holders pin at most
// BACKGROUND_TX_MAX connections and bg-query holders at most BACKGROUND_QUERY_MAX,
// so as long as
//
//     BACKGROUND_TX_MAX + BACKGROUND_QUERY_MAX ≤ POOL_MAX − RESERVED_INTERACTIVE
//
// at least RESERVED_INTERACTIVE connections always remain free — the bg-query
// holders can therefore always finish and release the slots the transactions are
// waiting on, and no cycle can close. That inequality IS the proof, so it is
// asserted below at module load rather than left in prose.
// Exported for co-located unit testing: the deadlock proof is an arithmetic
// relation between these four, so the test asserts the relation rather than
// re-deriving the numbers.
export const RESERVED_INTERACTIVE = 6;
const BACKGROUND_MAX = POOL_MAX - RESERVED_INTERACTIVE;
export const BACKGROUND_TX_MAX = 3;
export const BACKGROUND_QUERY_MAX = BACKGROUND_MAX - BACKGROUND_TX_MAX;

if (
  BACKGROUND_TX_MAX + BACKGROUND_QUERY_MAX >
  POOL_MAX - RESERVED_INTERACTIVE
) {
  throw new Error(
    `DB lane invariant violated: BACKGROUND_TX_MAX (${BACKGROUND_TX_MAX}) + ` +
      `BACKGROUND_QUERY_MAX (${BACKGROUND_QUERY_MAX}) exceeds POOL_MAX (${POOL_MAX}) - ` +
      `RESERVED_INTERACTIVE (${RESERVED_INTERACTIVE}). The background lane can deadlock: ` +
      `a transaction holding a connection can wait forever for a query slot that never frees.`,
  );
}

const backgroundQueryGate = createSemaphore(BACKGROUND_QUERY_MAX);
const backgroundTxGate = createSemaphore(BACKGROUND_TX_MAX);

// Occupancy gauges for the flight recorder's gate snapshot: layer names join to
// the corresponding `chargeWait` layers in span `waits`. `background-acquire` is
// the background query gate and `background-tx-acquire` the background
// transaction gate; `db-pool` is the gauge for the `db-acquire` wait layer —
// occupancy of the raw pg pool (held connections + queued checkouts), not either
// gate. pg.Pool's totalCount/idleCount/waitingCount are free property reads.
//
// `background-acquire` is the former `loader-acquire`, renamed with the gate's
// semantics: the gate no longer means "a loader is querying" — jobs, flush's own
// direct queries, and the observability writes all charge to it now, while a
// loader running under a `sub` origin does not. Keeping the old name would make
// every trace lie about who is queueing.
registerGateGauge("background-acquire", () => backgroundQueryGate.stats());
registerGateGauge("background-tx-acquire", () => backgroundTxGate.stats());
registerGateGauge("db-pool", () => {
  const p = poolSingleton;
  if (!p) return { active: 0, queued: 0, max: POOL_MAX };
  return {
    active: p.totalCount - p.idleCount,
    queued: p.waitingCount,
    max: POOL_MAX,
  };
});

// A loader's read-set contains ONLY the tables it READS — matched from the read
// clauses FROM / JOIN. Write targets (INSERT INTO / UPDATE / DELETE) are
// deliberately excluded: loaders are read-only by contract, so any write captured
// under a loader's ambient context is a foreign observability leak (e.g. the
// report path's `INSERT INTO "notifications"` running inside whatever loader
// happened to be open), never a genuine read dependency. Exported for co-located
// unit testing.
//
// HOW THE NAME IS SPELLED DOES NOT MATTER. Drizzle double-quotes every
// identifier it emits; a hand-written `sql` template usually does not, because
// that is how people write SQL. Both are matched, and they differ only in what
// happens after the match:
//
//   - a QUOTED name is taken as written, exactly as it always has been;
//   - an UNQUOTED name is only a candidate. Anything at all can follow FROM — a
//     CTE name, a subquery alias, a set-returning function — so a candidate is
//     kept only if it names a relation that really exists in the `public` schema
//     (`setKnownRelations` below). A phantom name in a read-set is not free
//     noise: the Debug → Read-set pane calls a resource a "silent FULL" the
//     moment its read-set holds a table the change-feed does not cover, so
//     unfiltered aliases would drown the one surface that exists to spot this
//     class of bug. While no relation set is installed — before boot loads it,
//     and on the central runtime, which never touches this pool — every unquoted
//     candidate is dropped, so capture is then byte-identical to the
//     quoted-only behaviour this replaces.
//
// Three guards on the unquoted branch, each with a live site in this repo:
//   - `IS DISTINCT FROM` is an operator, not a FROM clause, and what follows it
//     is an expression (`page-doc-order.ts` has one inside a live loader). It is
//     matched and then dropped, the same way `DELETE FROM`'s write target is —
//     matching it is what stops the bare `from` branch from picking its operand
//     up.
//   - a candidate immediately followed by `(` is a function call, not a relation
//     — `FROM unnest(…)` and `CROSS JOIN LATERAL (…)`, both in the chord
//     progress loader.
//   - a leading `ONLY` belongs to the clause, not to the name, so `FROM ONLY
//     tasks` captures `tasks`.
//
// A schema-qualified name keeps only its relation part when the schema is
// `public` (which is what the change-feed reports as `TG_TABLE_NAME`), and is
// dropped whole otherwise: the jobs list loader reads
// `FROM graphile_worker._private_jobs`, a schema the change-feed structurally
// excludes, so recording it would add a dependency that can never fire.
//
// One over-capture stays possible: a CTE named after a real table
// (`WITH tasks AS (…) SELECT … FROM tasks`) records a phantom dependency. That
// costs one extra recompute and never a missed one — the direction this index
// has always been allowed to err in.
export function extractReadTablesFromSql(text: string): string[] {
  const tables = new Set<string>();
  for (const name of readClauseNames(text)) {
    if (name.quoted) {
      tables.add(name.text);
      continue;
    }
    const relation = publicRelationName(name.text);
    if (relation !== null && knownRelations?.has(relation))
      tables.add(relation);
  }
  return Array.from(tables);
}

/**
 * The relations a read-set captures from `text` whatever relation set is
 * installed: every double-quoted name a read clause (FROM / JOIN) names,
 * deduped, in order of first appearance — exactly the quoted branch of
 * {@link extractReadTablesFromSql}, with no known-relations filter. Pure.
 *
 * What a compiler rendering raw SQL checks its text against: a quoted name is
 * taken as written, so a CTE or subquery alias spelled quoted would land in
 * every read-set the query is captured under (a phantom dependency the
 * Read-set pane reports as a silent FULL). A raw shape therefore spells its
 * own names unquoted, and the relations this returns for it must be exactly
 * the tables it routes.
 */
export function quotedRelationsIn(text: string): string[] {
  const out = new Set<string>();
  for (const name of readClauseNames(text)) {
    if (name.quoted) out.add(name.text);
  }
  return Array.from(out);
}

/**
 * Every name a read clause (FROM / JOIN) introduces in `text`, in order: a
 * double-quoted one as written, or an unquoted candidate (a function call —
 * a candidate followed by `(` — already dropped). `DELETE FROM`'s write target
 * and `IS DISTINCT FROM`'s operand are matched and dropped (see
 * {@link extractReadTablesFromSql}).
 */
function* readClauseNames(
  text: string,
): Generator<{ quoted: boolean; text: string }> {
  const re =
    /\b(distinct\s+from|delete\s+from|from|join)\s+(?:only\s+)?(?:"([^"]+)"|([a-z_][\w$.]*))(\s*\()?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const keyword = m[1]!.toLowerCase().replace(/\s+/g, " ");
    if (keyword !== "from" && keyword !== "join") continue; // write target / operator
    const quoted = m[2];
    if (quoted !== undefined) {
      yield { quoted: true, text: quoted };
      continue;
    }
    if (m[4] !== undefined) continue; // a call — `unnest(`, `lateral (`
    yield { quoted: false, text: m[3]! };
  }
}

// Postgres folds an unquoted identifier to lower case, so a candidate is
// normalised the same way before it is looked up. Returns null for a name
// qualified with a schema other than `public` — the change-feed reports changes
// under the bare relation name and covers `public` only.
function publicRelationName(candidate: string): string | null {
  const parts = candidate.toLowerCase().split(".");
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2 && parts[0] === "public") return parts[1]!;
  return null;
}

// The relations that really exist in `public`, as of the last load. `null` means
// none has been installed, which is the state of every process that never calls
// `loadKnownRelations` — and the reason an unquoted candidate is dropped rather
// than trusted there.
let knownRelations: ReadonlySet<string> | null = null;

// Exported for co-located unit testing: the filter is module-local state, so a
// test installs and clears its own set rather than reaching for a database.
export function setKnownRelations(relations: ReadonlySet<string> | null): void {
  knownRelations = relations;
}

const KnownRelationRowSchema = z.object({ relname: z.string() });

/**
 * Read which relations `public` really holds and install them for
 * {@link extractReadTablesFromSql}.
 *
 * Ordinary and partitioned tables plus plain and materialized views: loaders
 * read the derived views (`tasks_v`, `attempts_v`, …) as readily as base
 * tables, and the change-feed already expands a base-table change onto them.
 *
 * Idempotent, and it replaces the set wholesale — so it is safe to call again
 * after later DDL creates more relations (change-feed creates
 * `live_state_changelog` inside its own barrier hook).
 */
export async function loadKnownRelations(
  executor: NodePgDatabase,
): Promise<void> {
  const rows = await executeRows(executor, {
    query: drizzleSql.raw(
      `SELECT c.relname::text AS relname
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m')`,
    ),
    row: KnownRelationRowSchema,
    label: "loadKnownRelations",
  });
  setKnownRelations(new Set(rows.map((r) => r.relname)));
}

// Postgres deadlock-victim (40P01) and serialization-failure (40001) are, by
// definition, retryable: the conflicting statement was rolled back whole and
// holds nothing. pool.query only ever runs a single autocommit statement
// (explicit transactions go through pool.connect() → client.query and bypass
// this wrapper — see plugins/database/CLAUDE.md), so a fresh re-execution is
// always safe and correct: there is no partial-transaction state to lose. The
// concrete victim this absorbs is the derived-views boot rebuild, which holds a
// brief AccessExclusive window over its views (DROP+CREATE in one tx) — during a
// hot-swap restart that window used to kill concurrent readers on the previous
// backend (the tasks loader, the allow-files poll) with a hard "deadlock
// detected" crash. Bounded jittered retry rides out the window instead of
// surfacing it; a genuinely persistent deadlock still throws after the cap, so a
// real lock-order bug stays loud.
const RETRYABLE_SQLSTATES = new Set(["40P01", "40001"]);
const MAX_QUERY_RETRIES = 4;
const queryRetryDelay = withJitter(exponential({ initial: 10, max: 250 }));

// Every retry is logged, persistently. The retry self-heals transient contention
// (DDL vs reads) but is NOT silent: a recurring deadlock — e.g. a genuine
// lock-order bug — surfaces here as a steady stream of lines even while it keeps
// succeeding within the cap, instead of vanishing. Grep `db.jsonl` for
// `[deadlock-retry]`; a rising rate is the signal to fix the source, not the cap.
// Durable "db" log. `defineLogSink` registers the channel env-free and defers
// the file-sink (its per-worktree path resolution) to first publish, so
// importing @plugins/database/server stays import-safe. It also carries every
// connection's `[deadline]` lines, written by `database/query-deadline`'s sink
// handler — the connection plugin stays below log-channels.
export const dbLog = defineLogSink({
  id: "db",
  description:
    "Database log: the app pool's transient-contention SQL retries ([deadlock-retry]) and, on every backend connection, calls that got no reply within their deadline ([deadline]); read via db.jsonl.",
});

function retryableSqlState(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const code = (err as { code?: string }).code ?? "";
  return RETRYABLE_SQLSTATES.has(code) ? code : null;
}

// The deadline is not this wrapper's: every client of the app pool is a
// `DbClient` (`createDbPool`, @plugins/database/plugins/connection), which bounds
// each `connect()` and `query()` on the connection itself and abandons a lost
// one. What only the app pool has stays here — lane gates, deadlock retry,
// `[acquire]` spans, read-set capture — plus the one piece of lease bookkeeping
// that must end with a lost connection: the background-transaction gate slot.

// Install the timing/gating wrapper onto a freshly-built pool's `query` and
// `connect`. Called exactly once, from `pool()`, so the wrapper is bound to the
// same pool instance `db` and `awaitDbReady`/`warmPool` use. See the block
// comment on each concern. Exported for co-located unit testing: the invariants
// it enforces (lane partition, tx lease accounting) are testable against a fake
// `pg.Pool`-shaped object, with no database; the lost-connection path against a
// real `DbClient` with a short `deadlineMs`.
export function installQueryWrapper(pool: Pool): void {
  const origQuery = pool.query.bind(pool);
  const origConnect = pool.connect.bind(pool);

  // Time every query that flows through pool.query (all drizzle ORM queries).
  // The promise form is reimplemented to split the two phases that node-postgres
  // Pool.query collapses internally — connection acquisition (pool queue-wait +
  // pgbouncer backend establishment) and query execution — into two separate
  // spans:
  //   - "[acquire]" : time to check out a live connection. At cold boot this is
  //                   where the multi-second cost lives; once warm it's sub-ms.
  //   - "<sql text>": pure execution time on an already-acquired client.
  // Before this split, the single "db" span lumped acquisition into execution, so
  // a trivial PK lookup could read as multi-second right after a restart. The
  // callback form is passed straight through to origQuery untouched (drizzle never
  // uses it). Direct pool.connect() → client.query paths still bypass timing —
  // see plugins/database/CLAUDE.md.
  //
  // Background-origin queries additionally route through `backgroundQueryGate`, so
  // background query load caps at BACKGROUND_QUERY_MAX concurrent connections and
  // interactive work keeps reserved capacity. The gate wait is CHARGED to the
  // enclosing entry (via chargeWait) under the "background-acquire" layer, so the
  // wait lands on the waiting resource's own span (work = total − Σwaits,
  // lock-vs-work readable directly) instead of in a label-shared
  // `db [background-acquire]` bucket. The origin class is read synchronously,
  // before any await, so the profiler's ambient context is still active. The
  // pool's own `[acquire]` (connect) and `<sql>` (execute) leaf spans stay —
  // those are real per-query measurements, not gate waits.
  // biome-ignore lint/suspicious/noExplicitAny: pass-through wrapper over pg's overloaded query signature.
  pool.query = ((...a: Parameters<typeof origQuery>): any => {
    const last = a[a.length - 1];
    if (typeof last === "function") return origQuery(...a); // callback form, untimed + ungated

    const text = queryText(a[0]);

    const runOnce = async () => {
      const acq0 = performance.now();
      // `origConnect`, so this checkout takes no transaction lease and applies
      // no read-set patch. A client still carrying one from an earlier
      // transaction checkout records its tables twice here; a read-set is a
      // Set, so the repeat costs nothing.
      const client = await origConnect();
      const acqMs = performance.now() - acq0;
      // The leaf "[acquire]" span keeps rate visibility; the chargeWait ALSO
      // lands the same duration in the enclosing entry's waits ("db-acquire"
      // layer), so the caller's wall-clock decomposition sums instead of the
      // connect-wait hiding inside a label-shared leaf bucket.
      recordSpan("db", "[acquire]", acqMs);
      chargeWait("db-acquire", acqMs);
      try {
        const exec0 = performance.now();
        // The statement's deadline is the client's own (armed at this call).
        // biome-ignore lint/suspicious/noExplicitAny: proxy pg's overloaded query.
        const res = await (client.query as any)(...a);
        recordSpan("db", text, performance.now() - exec0);
        return res;
      } finally {
        // Success or error, the connection goes back — unless the deadline lost
        // it, where the client's own `release()` is a no-op (it was abandoned).
        client.release();
      }
    };

    // Re-run the statement (fresh connection each attempt) on a deadlock/
    // serialization victim; non-retryable errors propagate immediately, and the
    // attempt cap re-throws a persistent conflict so it never loops forever.
    // `QueryDeadlineExceededError` has no `.code`, so a lost statement is never
    // retried. Each attempt's statement has its own clock: a retry only follows
    // a REPLY (the victim's error), so a hang still costs one bound.
    const runRetrying = () =>
      retryUntil(
        async (attempt) => {
          try {
            return await runOnce();
          } catch (err) {
            const sqlstate = retryableSqlState(err);
            // Non-retryable errors, and a retryable one that has exhausted the cap,
            // propagate — a persistent deadlock still crashes loudly.
            if (sqlstate === null || attempt >= MAX_QUERY_RETRIES) throw err;
            dbLog.publish(
              `[deadlock-retry] sqlstate=${sqlstate} attempt=${attempt + 1}/${MAX_QUERY_RETRIES} sql=${text.slice(0, 160)}`,
              "stderr",
            );
            return null; // retryable victim — back off and retry
          }
        },
        { delay: queryRetryDelay },
      );

    // Read-set capture is keyed on the CALLER kind and is orthogonal to the lane:
    // only a `loader` entry has a read-set (the tables its resource depends on),
    // and it has one whether a human or the cascade is driving it. A `cascade`
    // entry's reads are deliberately not captured — they are edge
    // (ids-translation) reads, not the downstream resource's value dependencies,
    // so indexing them would raise a false silent-FULL flag (see the
    // resource-runtime cascade). Observation-only: affects neither timing nor
    // gating.
    if (currentCallerKind() === "loader") {
      recordReadTables(extractReadTablesFromSql(text));
    }

    // Gate by ORIGIN class, not caller kind. What changes versus the old
    // `callerKind === "loader" | "cascade"` condition:
    //   - a `sub`-origin loader query is now UNGATED — a human's cold pane load no
    //     longer queues FIFO behind hundreds of cascade recomputes (Gap A);
    //   - a `job`-origin query is now GATED — graphile jobs are background by
    //     nature and used to run against the reserved floor (Gap C);
    //   - a `flush` entry's own DIRECT queries are now GATED — caller kind
    //     `"flush"` matched neither arm of the old condition, so the flush cycle's
    //     own reads slipped through the gate they exist to sit behind.
    // Interactive stays UNGATED, matching today's `http` semantics: it is already
    // bounded upstream by `readLoadGate` (READ_LOAD_CONCURRENCY = 6,
    // resource-runtime/core/runtime.ts:906) for cold reads and by per-route
    // endpoint concurrency gates for mutations, and adding a third bound here
    // would only re-serialize the lane we are trying to keep free.
    // Context-less work (boot, migrations, `warmPool`, the change-feed listener)
    // has no ambient entry and stays UNGATED, so boot can never deadlock on a gate.
    if (currentOriginClass() === "background") {
      return backgroundQueryGate.run(runRetrying, {
        onWait: (waitMs) => chargeWait("background-acquire", waitMs),
      });
    }
    return runRetrying();
  }) as typeof pool.query;

  // Gate background TRANSACTIONS. `pool.connect()` hands out a raw pooled client
  // that bypasses the `pool.query` wrapper entirely — no timing, no lane gate,
  // and (until now) no reservation. Read-set capture is the one concern that
  // follows the client out (`wrapClientQueryForReadSet`, applied on every
  // non-callback path below), because a loader reading inside a transaction has
  // a read-set just the same. It is the path drizzle's `db.transaction()`
  // takes (`NodePgSession` does `await this.client.connect()` when
  // `client instanceof Pool`, which is why `db` must keep proxying a real
  // `pg.Pool`). Under event-loop lag a transaction holds its connection across
  // every `await` continuation, so inflated background transactions ate all 16
  // connections *including the reserved 6* — this bypass is what turned the
  // 2026-07-09 afternoon incident from slow into unusable.
  //
  // The gate is a LEASE, not a scope: the slot is taken when the client is handed
  // out and freed when the caller releases it, because that is exactly the window
  // in which the connection is pinned. `origConnect` was captured above, before
  // this override, and `runOnce` calls it — so a query-path checkout is charged to
  // the query gate only and is never double-gated here.
  //
  // Every query on the checked-out client is bounded by the client itself; a lost
  // one abandons it, and the lease's slot is freed with it (`armLease`).
  // biome-ignore lint/suspicious/noExplicitAny: pass-through wrapper over pg's overloaded connect signature.
  pool.connect = ((...a: Parameters<typeof origConnect>): any => {
    // Callback form — untouched, exactly like `pool.query`'s. Nothing in the repo
    // uses it; pg's own internals may.
    if (typeof a[0] === "function") return origConnect(...a);

    // Read the lane synchronously, before any await, while the ambient entry
    // context is still the caller's. Interactive checkouts (HTTP mutations) and
    // context-less ones (`awaitDbReady`, `warmPool`) take no gate: the former are
    // allowed the reserved floor, and the latter must never be able to wait on a
    // gate at boot. Both still get read-set capture — a loader that reads inside
    // a transaction has a read-set whichever lane it runs in.
    if (currentOriginClass() !== "background") {
      return origConnect().then(wrapClientQueryForReadSet);
    }

    return (async (): Promise<PoolClient> => {
      const releaseSlot = await backgroundTxGate.acquire({
        onWait: (waitMs) => chargeWait("background-tx-acquire", waitMs),
      });
      let client: PoolClient;
      try {
        client = await origConnect();
      } catch (err) {
        // The checkout failed, so nothing will ever call `release()` on a client
        // we never got. Hand the slot back before rethrowing, or the gate leaks a
        // slot per failed connect and eventually wedges the background lane shut.
        releaseSlot();
        throw err;
      }
      return armLease(wrapClientQueryForReadSet(client), releaseSlot);
    })();
  }) as typeof pool.connect;
}

// Record the read-set of a query issued on a CHECKED-OUT client, which is the
// path `db.transaction()` takes. `pool.query` is where every other read is seen,
// and a checked-out client never passes through it — so without this a loader
// that wrapped its reads in a transaction recorded no tables at all, and its
// resource silently served stale data. Same failure as an unrecognised table
// name, different spelling.
//
// Deliberately the read-set line and nothing else: timing and the `[acquire]`
// span still bypass a checked-out client (see plugins/database/CLAUDE.md), and
// this wrapper takes no gate, touches no lease and changes no result.
//
// The patch is per CLIENT, not per checkout — pg reassigns `release` on every
// checkout but keeps the same `query` — so it is applied once and then left
// alone, or every checkout of a pooled client would stack another layer of
// wrapper on the last. Which caller is asking is read at call time, so one
// lasting patch is correct for every future checkout.
const readSetWrappedClients = new WeakSet<PoolClient>();

function wrapClientQueryForReadSet(client: PoolClient): PoolClient {
  if (readSetWrappedClients.has(client)) return client;
  readSetWrappedClients.add(client);
  const clientQuery = client.query.bind(client);
  // biome-ignore lint/suspicious/noExplicitAny: pass-through wrapper over pg's overloaded query signature.
  client.query = ((...a: Parameters<typeof clientQuery>): any => {
    // Same gate as the `pool.query` path: only a `loader` entry has a read-set,
    // and it has one whether a human or the cascade is driving it. Observation
    // only — the call itself is handed on untouched, callback form included.
    if (currentCallerKind() === "loader") {
      recordReadTables(extractReadTablesFromSql(queryText(a[0])));
    }
    return clientQuery(...a);
  }) as typeof client.query;
  return client;
}

// Turn one background checkout into a gate lease: the slot is held from checkout
// until the lease ends, exactly once, one of two ways:
//   - the caller releases: pg's release runs with `err` forwarded unchanged
//     (pg's `release(err)` destroys rather than returns the connection when
//     `err` is truthy, and swallowing it would quietly return a poisoned
//     connection to the pool), and the slot is freed;
//   - a call on the client misses its deadline first: the client is lost and
//     abandoned by the connection plugin, and the slot is freed right then —
//     drizzle calls no `release()` at all when its `BEGIN` is the statement that
//     hung. The holder's later `release()` reaches the client's own, which is a
//     no-op on a lost client.
// `release` is patched per checkout (pg-pool assigns it per checkout, so this
// affects only this lease). A second caller `release()` stays loud (pg's
// double-release error) and never frees a slot this lease no longer holds.
function armLease(client: PoolClient, releaseSlot: () => void): PoolClient {
  const pgRelease = client.release.bind(client);
  let callerReleased = false;
  let slotFreed = false;

  const freeSlot = () => {
    if (slotFreed) return;
    slotFreed = true;
    releaseSlot();
  };
  const unsubscribe = onClientLost(client, freeSlot);

  client.release = (err?: Error | boolean): void => {
    if (callerReleased) return pgRelease(err); // a caller bug: pg stays loud
    callerReleased = true;
    unsubscribe();
    try {
      return pgRelease(err);
    } finally {
      freeSlot();
    }
  };
  return client;
}

// Lazily-constructed singleton pool. Importing this module never builds a pool or
// asks for this process's namespace; the worktree name is required only when the
// first real query/connection is issued (`pool()` → `runtimeNamespace()`). node-postgres
// pools connect lazily, so building the pool opens no connection either — the warm
// step in `warmPool()` does that explicitly at boot.
let poolSingleton: Pool | null = null;

function pool(): Pool {
  if (poolSingleton) return poolSingleton;
  const p = createDbPool({
    name: "app",
    connectionString: buildConnectionString(conn, runtimeNamespace()),
    max: POOL_MAX,
    idleTimeoutMillis: 20_000,
  });
  installQueryWrapper(p);
  poolSingleton = p;
  return p;
}

// Lazily-built real drizzle instance over the real per-worktree pool. Kept behind
// `db` (a forwarding Proxy) so that: (a) importing this module builds nothing —
// the pool is created on the first `db.<method>()` call, not at eval; and (b) the
// underlying client is a genuine `pg.Pool`, which drizzle's session requires
// (`this.client instanceof Pool`) to open a dedicated connection for
// `db.transaction()`. A faked/proxied pool would silently break transactions.
// Derive the type from the concrete `drizzle(pool())` call (not `ReturnType<typeof
// drizzle>`, which resolves to the broad variadic overload) so `db` keeps the exact
// `NodePgDatabase<Record<string, never>>` type the original eager `drizzle(pool)`
// produced — consumers are typed against it.
function buildDb() {
  return drizzle(pool());
}
type DrizzleDb = ReturnType<typeof buildDb>;
let dbSingleton: DrizzleDb | null = null;

function realDb(): DrizzleDb {
  if (!dbSingleton) dbSingleton = buildDb();
  return dbSingleton;
}

// Bound-method cache: `realDb()` is a stable singleton once built, so each method
// need bind only once. Non-function properties (e.g. `db.query` RQB namespace,
// `db.$client`) forward straight through.
const boundMethods = new Map<PropertyKey, unknown>();

export const db: DrizzleDb = new Proxy({} as DrizzleDb, {
  get(_target, prop) {
    const real = realDb() as unknown as Record<PropertyKey, unknown>;
    const value = real[prop];
    if (typeof value !== "function") return value;
    let bound = boundMethods.get(prop);
    if (bound === undefined) {
      bound = (value as (...args: unknown[]) => unknown).bind(real);
      boundMethods.set(prop, bound);
    }
    return bound;
  },
});

export function isTransientDbError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; errno?: string };
  const code = e.code ?? e.errno;
  return code === "57P03" || code === "ENOENT" || code === "ECONNREFUSED";
}

const PG_READY_TIMEOUT_MS = 30_000;
let readyPromise: Promise<void> | null = null;

export async function awaitDbReady(): Promise<void> {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    let lastErr: unknown = null;
    await retryUntil(
      async () => {
        try {
          const client = await pool().connect();
          try {
            await client.query("SELECT 1");
            return true;
          } finally {
            client.release();
          }
        } catch (err) {
          if (!isTransientDbError(err)) throw err;
          lastErr = err;
          return null;
        }
      },
      {
        delay: exponential({ initial: 100, max: 1_000 }),
        deadline: PG_READY_TIMEOUT_MS,
        onDeadline: () => {
          throw new Error(
            `Database did not become reachable within ${PG_READY_TIMEOUT_MS}ms`,
            { cause: lastErr },
          );
        },
      },
    );
  })();
  return readyPromise;
}

// Eagerly open and validate connections up to the pool's `max` so the first
// real-query wave (the onReady thundering herd + the frontend's first loaders)
// hits live connections instead of paying connection-establishment cost. The
// SELECT 1 on each forces pgbouncer to attach a backend now, not on the first
// user query. node-postgres `min` does NOT pre-connect — it only avoids
// destroying idle connections — so this explicit warm step is required. Called
// from the database plugin's onReady, after awaitDbReady() and before migrations
// and any other plugin's onReady. awaitDbReady() leaves 1 connection idle, so we
// only open the remainder; self-healing if `max` is small (e.g. 1 in tests).
export async function warmPool(): Promise<void> {
  const p = pool();
  const target = p.options.max ?? 5;
  const need = target - p.idleCount;
  if (need <= 0) return;
  const clients = await Promise.all(
    Array.from({ length: need }, () => p.connect()),
  );
  await Promise.all(clients.map((c) => c.query("SELECT 1")));
  for (const c of clients) c.release();
}
