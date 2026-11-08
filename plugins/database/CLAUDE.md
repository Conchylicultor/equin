# database

Owns all database infrastructure for the equin server:

- **Connection pooling** — `db` (Drizzle instance), `pool` / `adminPool` (raw pg pools), `openShortLivedClient`, `connectionString`, `libpqSubprocessEnv`, `isTransientPgError`, `awaitPgReady`.
- **Migrations** — SQL files live in `plugins/database/plugins/migrations/data/`; `drizzle.config.ts` lives at `plugins/database/plugins/migrations/core/drizzle.config.ts`. The migration runner lives in `plugins/database/plugins/migrations/server/`.
- **Embedded Postgres constants & helpers** — `plugins/database/plugins/embedded/`.
- **DB query MCP tool** — `plugins/database/plugins/query/` (read-only agent inspection tool).

## Typed at the SQL boundary

Sibling guardrails, one class of bug: a type written by hand where nothing
verifies it. They split by spelling — around the row, inside the row, and on the
column — so there is never a question of which one owns a site.

| you have | owner |
|---|---|
| a raw SQL **result** — `pool.query(…)`, `db.execute(sql\`…\`)` — whose rows you read | `plugins/database/plugins/sql-rows` — parse the rows (`queryRows` / `executeRows`) |
| a raw SQL **expression selected as a value** — ``sql`…` `` in a `db.select()` or a `pgView` | `plugins/database/plugins/sql-projection` — give it a decoder (`.mapWith(…)`) |
| a **column** narrower than the Postgres type under it — a string-literal union, or a shape over `jsonb`, in a `tables.ts` | `plugins/database/plugins/sql-column` — decode it (`parsedText(name, schema)` / `parsedJson(name, schema)`). A `jsonb` column whose value really is arbitrary keeps a bare `jsonb(x)` and its honest `unknown` |
| a raw SQL **write** — an INSERT / UPDATE / DELETE / MERGE in a ``sql`…` `` tag or a `pool.query` string | `plugins/database/plugins/sql-writes` — parsed with Postgres's grammar and checked against the declared schema (`sql-writes:fit`): known tables and columns, required columns inserted, no write to a derived `updated_at` or a generated column |
| a column `defineEntity` derives from a **field record** | nothing to do — the field type's storage contribution decodes it, text and jsonb alike (`fields/{text,json,tags}/plugins/storage`); see `plugins/infra/plugins/entities/CLAUDE.md` |

All are enforced (`sql-rows/no-unparsed-sql-rows`,
`sql-projection/no-asserted-sql-type`, `sql-column/no-asserted-column-type`,
`sql-writes:fit`), and the three decoding plugins' `CLAUDE.md` carries the measured pg decoding facts — including the
one that catches everybody once:
**`timestamptz` has no single answer.** Through drizzle raw SQL it is a `string`;
through a raw `pg` client it is a `Date`; through a drizzle column it is a `Date`.
Nothing in the SQL shows which.

## `db` over the host's driver: `DatabaseDriver`

`db` (`server/internal/driver.ts`) is a forwarding Proxy over the booted host's
**`DatabaseDriver`** host service (`{ db(), ready(), bootDdl(fn, reason?),
listen(channels, handlers) }` — `listen` opens the change feed's LISTEN
session, the one part of it that differs per host): the boot
barrier calls `ready()` then runs the schema layer under `bootDdl`, over the
migration texts of the host's `MigrationSource` (`database/migrations`). The
read-set capture (`server/internal/read-set-capture.ts`) and `afterCommit(exec,
fn)` — work that must not run before a top-level `db.transaction` commits, the
Proxy tracking each one it opens — are portable. The desktop's driver is
`database#machine`: everything below (the lazy `pg.Pool`, the lane gates, the
deadlock retry, the query deadline) lives in `machine/internal/pg-driver.ts`. A
host without the cluster boots `plugins/pglite`. Under `bun test` the preload
provides the desktop's driver (see `test/bun-preload.ts`).

## Causal tokens: `currentTxId` and `snapshotWatermark`

Both are xid8 decimal text, compared as BigInt. `currentTxId(tx)` is a write's
ack token (read inside its transaction). `snapshotWatermark(exec)`
(`server/internal/snapshot-watermark.ts`) is the xmin of the current snapshot:
the resource runtime's commit watermark, which every frame that fully
reconciles a client carries. This plugin owns it: `onReadyBlocking` installs it
into server-core (`setWatermarkSource`) right after `driver.ready()`, on every
host with a database — the browser worker included — and a serving host whose
graph reads the database without one fails at boot
(`assertDbReadsHaveWatermarkSource`). L2 (`live-state-snapshot`) only consumes
the same capture, as a persisted value's floor. A suite that builds its own
runtime takes the real capture from `@plugins/database/server/testing`.

`database/core`'s `readDatabaseConfigSync` (`readFileSync`) stays in `core/` (debt):
CLIs, checks and e2e scripts read it there.

## Runtime query profiling

`pool.query` is wrapped (in `machine/internal/pg-driver.ts`) to record per-query
timing into the runtime-profiler recorder (`db` spans). The promise form is
reimplemented to split the two phases node-postgres collapses into one — it
emits a separate **`[acquire]`** span for connection checkout (pool queue-wait +
pgbouncer backend establishment) and a **`<sql text>`** span for pure execution
on an already-acquired client. This keeps a trivial query from reading as
multi-second right after a restart when the cost is really cold-connection
acquisition; a spiking `[acquire]` aggregate is the signal for that. Each `db`
span is attributed to the innermost enclosing request/loader (its `parent`) via
the recorder's ambient context, so N+1 patterns point straight at the caller.
**A query on a checked-out client — `pool.connect()` → `client.query`, which is
the path `db.transaction()` takes — is still not timed.** It never reaches
`pool.query`, so it gets no `[acquire]` span and no `<sql>` span, and the
durations of `awaitDbReady`'s `SELECT 1` and of `warmPool`'s probes are not
recorded. **Read-set capture no longer bypasses it:** `installQueryWrapper`
patches the checked-out client's `query` too (`wrapClientQueryForReadSet`), so a
loader that reads inside a transaction records its tables exactly as it would
through `pool.query` — before, it recorded none and its resource silently served
stale data. The patch is applied once per client, since pg reassigns `release`
on every checkout but keeps the same `query`.

What a capture records is read off the SQL text by `extractReadTablesFromSql`:
every name a FROM / JOIN introduces — a double-quoted one as written, an
unquoted one only when it names a real `public` relation. **`quotedRelationsIn(text)`**
(server barrel, pure) is the quoted half alone, with no relation filter: what
a raw-SQL compiler checks its rendered text against. A quoted CTE or subquery
alias would land in every read-set the query is captured under, so a raw shape
spells its own names unquoted (query-resource's A38) and the quoted relations
of its text must be exactly the tables it routes.

## Every statement names its origin

Every statement on the app pool carries the runtime-profiler entry it ran under
as a leading comment, `/* origin=conversations.usage:sync */ `
(`tagClientQueriesWithOrigin` in `machine/internal/pg-driver.ts`, installed once
per physical connection on pg-pool's `connect` event, so it is the innermost
layer of both `pool.query` and the checked-out-client path `db.transaction()`
takes). It is what lets the database side name who holds a lock:
`pg_stat_activity.query` shows the comment, and `database/lock-watch` reads it.
Not `application_name`: pgbouncer runs in transaction mode, so no `SET`
survives into the next client's transaction. (A client's startup
`application_name` does survive, and every connection carries `equin:<pool>`
there — but that names the connection, not the caller.)

- The format is `database/connection` core's (`tagSqlWithOrigin` /
  `parseSqlOrigin`); the label is reduced to `[A-Za-z0-9._:/@=+-]` (anything
  else becomes `_`) and cut at 120 chars, so it can neither close its comment
  nor contain a `from <name>` the read-set capture would read.
- The read-set capture sits outside it and reads the untagged text; the
  connection's own label (`queryText`) strips the comment, so spans and
  deadline reports name the statement alone (their `origin` field names the
  caller).
- Untagged: context-less calls (boot, migrations), a Submittable, and a NAMED
  prepared statement (pg refuses one name with two texts).
- Cost, measured in `pg-driver.test.ts` over a fake client (200k statements):
  ~30–60 ns per statement for the whole wrapper, the tag adding ~0–30 ns over
  the untagged path (within run-to-run noise) — against a round trip of
  ≥ 100 µs through pgbouncer.

## Query deadline (a call with no reply fails; its connection is closed)

Every database call on **every backend connection** has a client-side deadline —
**60 s** by default — on both phases: **opening a connection** and **each query**.
It lives in `plugins/database/plugins/connection` (read its `CLAUDE.md`): every
pool and standalone client is built by `createDbPool` / `createDbClient`, whose
`pg.Client` subclass bounds `connect()` and `query()` on the connection itself.
Each connection is named from a closed list (`app`, `jobs-runner`,
`jobs-enqueue`, `jobs-schema`, `job-lock`, `admin`, `admin-short-lived`,
`fork-lease`, `change-feed`, `events-test`, `app-background`, …), and every expiry names its pool and phase. The
connection plugin's `CLAUDE.md` lists which code builds each one. Whole-database
DDL on the admin pool (`CREATE` / `DROP` / `RENAME DATABASE`) runs under a 10 min
bound (`database/admin`'s `runDatabaseDdl`).

Why: on 2026-09-11 a pooled socket was closed underneath a running query and the
live-state flush awaiting it waited forever
(`research/2026-09-11-global-live-updates-frozen-by-stray-fd-close.md`); on
2026-09-15 a job waited 2.5 h on a call no deadline covered
(`research/2026-09-16-global-db-call-deadline-every-connection.md`).

On expiry the caller gets `QueryDeadlineExceededError` (no `.code`, so the
deadlock retry never re-runs it), the connection is **closed** — dropped from
its pool and its socket destroyed, so Postgres rolls back its transaction and
releases its locks, and PgBouncer frees its slot — later calls on it fail at
once, the holder's own `release()` does nothing more, and the event goes to
`queryDeadlineSink` (reported by `database/query-deadline`). Until 2026-11-04
a lost connection was abandoned instead (never closed), for fear of a stray fd
close whose culprit — Bun's own double close, oven-sh/bun#33828 — was found and
fixed on 2026-09-16; see the connection plugin's "Why close".

What the app pool (`machine/internal/pg-driver.ts`) adds on top:

- **The pool is `createDbPool({ name: "app" })`.** `installQueryWrapper` keeps
  only what the app pool has: lane gates, the deadlock retry, `[acquire]` spans
  and read-set capture. It has no clock of its own. Of those, read-set capture is
  the one that also rides a checked-out client, because a transaction is just
  another way to spell a read.
- **One clock per attempt.** A 40P01/40001 retry re-runs the statement on a
  checked-out client, and that statement gets its own bound. A retry only follows
  a *reply* (the victim's error), so a hang still costs one bound, not five.
  Waiting for a connection and the retry backoff are not bounded.
- **The background-transaction lease frees its gate slot when its client is
  lost** (`onClientLost`), not only at `release()`: drizzle calls no `release()`
  when its `BEGIN` is what hung.
- **`withQueryDeadline({ ms, reason }, fn)`** widens (or narrows) the bound for
  every call `fn` awaits, on any connection. Boot DDL uses
  `BOOT_DDL_QUERY_DEADLINE_MS` (15 min; it can wait on the previous backend's
  locks during a hot-swap): the schema layer (`applySchemaLayer`: migrations,
  derived `updatedAt`, derived-tables and derived-views, one transaction) in this
  plugin's `onReadyBlocking`, and change-feed's trigger rebuild. The wraps sit at
  those call sites, not in the runners, which take `db` as a parameter precisely
  so they never import this barrel.

`warmPool()` (called in `onReadyBlocking`, after `awaitDbReady` and before migrations)
eagerly opens + validates connections up to the pool's `max` so the boot
thundering herd hits warm connections instead of paying establishment cost.
node-postgres `min` does **not** pre-connect, so this explicit step is required.
**Serving backends only**: `DatabaseDriver.ready({ warm })` takes the decision
as a required option, and the barrier passes `getBootMode() === "serve"`. An
`exec` child (a supervised job's body) serves nobody, and warming a full pool
per child (then 16 connections) is what ran pgbouncer out of `max_client_conn`
when a launch storm booted twenty children at once (2026-10-28). A serving
backend warms both lane pools (8 + 10).

`isTransientDbError` — what `awaitDbReady` waits out — includes a connect
refused because the database is full (`database/connection`'s
`isConnectionCapacityRefusal`), alongside a starting cluster and a missing
socket.

## Connection lanes (interactive vs background)

Every shared DB-capacity layer is partitioned by **origin class**, not by caller
kind. `currentOriginClass()` (runtime-profiler) walks the ambient entry chain to
its **root** and maps that root's kind to a lane:

| root entry kind | lane |
|---|---|
| `http`, `sub`, `loader` | `interactive` — a human is blocked |
| `flush`, `push`, `cascade`, `job` | `background` — nobody waits on this ms |
| *(no entry)* | ungated — boot, migrations, `warmPool`, graphile, the change-feed listener |

Reading the **root** rather than the innermost entry is the whole point: inside a
resource load the innermost caller kind is `loader` no matter *why* the load runs,
so the old `currentCallerKind()` gate could not distinguish a human's cold sub-ack
load from a cascade recompute — and queued the human behind hundreds of them.
`runInBackgroundLane(fn)` overrides the walk for work that is background whatever
triggered it (the observability writes; job cleanup).

### Each lane is its own pool, down to PgBouncer

The lane is not only a gate: each lane has its **own app `pg.Pool` and its own
PgBouncer server pool**. PgBouncer pools by (database, user), so the background
lane logs in as its own role, `<cluster user>_background` (`laneUser`), whose
sessions run as the cluster user (`ALTER ROLE … SET role`) — same ownership and
privileges — while `pg_stat_activity.usename` names the lane. The lane table
(`PGBOUNCER_LANES` in `database/pgbouncer/core`: per-database `pool_size`,
cluster-wide `max_user_connections`) sizes both the PgBouncer pools and the app
pools (`INTERACTIVE_POOL_SIZE` = 8 → pool `app`, `BACKGROUND_POOL_SIZE` = 10 →
pool `app-background`), so the two cannot disagree. drizzle is built over the
interactive pool; `installQueryWrapper(front, background)` routes a
background-origin statement or transaction to the background pool.

Why: on 2026-11-03, 16 background connections lost to a deadline were
abandoned (never closed, the rule then), each keeping its PgBouncer server slot
while it sat idle in a transaction; they took the one shared pool and `/home`
hung. Lost connections are closed now, but background work can still fill its
slots by being slow or blocked: with a pool per lane it exhausts only the
background pool — loudly, its calls missing their deadline on `app-background` —
and the interactive pool is never shared with it. Isolation, not headroom:
`research/2026-11-04-global-pgbouncer-pool-per-lane.md`.

`ready()` makes the lane exist before anything uses it. In the **host
singleton** only (`isHostSingleton()`: main in dev, the one backend of a
release) — these are machine-wide, and a worktree's code must never rewrite
them: the background role (created on the interactive pool under an advisory
lock, only when missing) and the PgBouncer config (`convergePgbouncerConfig`:
rewritten and `SIGHUP`-reloaded only when it differs — the gateway re-runs
PgBouncer's start script only at its own start). Then, in every serving backend,
a background login, which fails the boot naming the lane if PgBouncer refuses
it after a short wait for a pending reload (the host singleton re-sends the
reload once on a refusal). Without PgBouncer (a system Postgres) both lanes dial the cluster
directly as its user.

Two gates, both on `createSemaphore`, both read synchronously before any await:

- **`backgroundQueryGate`** (`BACKGROUND_QUERY_MAX = 7`) — every background-origin
  `pool.query`. Wait charged to the enclosing entry as `background-acquire` (the
  former `loader-acquire`; renamed because jobs, `flush`'s own queries, and
  observability writes charge to it now, while a `sub`-origin loader does not).
- **`backgroundTxGate`** (`BACKGROUND_TX_MAX = 3`) — a **lease**, not a scope, over
  `pool.connect()`: taken when the client is handed out, freed when
  `client.release()` is called. This is the path `db.transaction()` takes, which
  once bypassed both the wrapper *and* the reservation — inflated background
  transactions ate every connection of the then-shared pool. Wait charged as
  `background-tx-acquire`.

Interactive and context-less work runs **ungated** on the interactive pool, so
boot can never deadlock on a gate. Interactive demand is bounded upstream by
`readLoadGate` (`READ_LOAD_CONCURRENCY = 6`) and the per-route endpoint
concurrency gates.

### The lane-capacity invariant is a deadlock proof

```
BACKGROUND_TX_MAX + BACKGROUND_QUERY_MAX ≤ BACKGROUND_POOL_SIZE  (= PgBouncer's background pool_size)
        3         +          7           ≤         10
```

A background transaction pins a connection for its whole life and may `await` a
plain `pool.query` inside its callback. Under **one** shared background gate, N
transactions each holding a slot while awaiting a slot for their inner query
deadlock the lane permanently. Under **two**, the wait-for graph is acyclic by
construction — `bg-tx → bg-query → background pool connection` — and
the terminal holders always complete: bg-tx holders pin ≤3 connections and
bg-query holders ≤7, so every query holder finds a background connection — in the
app pool and in PgBouncer, the same number — to finish and release the slots the
transactions wait on. The inequality is asserted at module load, not left in
prose. (It assumes the lane's PgBouncer slots are the app's: a connection lost
to its deadline is closed, so PgBouncer frees its slot rather than keeping it.)
**Never raise either cap without re-checking it.**

The proof also needs background transaction leases **never to nest**: a holder of
one bg-tx slot waiting for a second closes a cycle inside the bg-tx gate itself,
and `BACKGROUND_TX_MAX` such holders wedge every background transaction (the
2026-10-30 incident: three `watch.deliver` jobs each held a lease inside their
claim and awaited a fourth for the turn ledger's own `conn.transaction` — Postgres
showed three sessions `idle in transaction` and no lock wait). This is
**enforced**: every `db.transaction()` runs in a lease scope (`withTxLeaseScope`,
an AsyncLocalStorage chain in `machine/internal/pg-driver.ts`), the background
checkout records its lease there, and a background `pool.connect()` asked for while
a lease in the same async call chain is still held rejects at once with
`NestedBackgroundTxLeaseError`, naming the entry and call site of both acquirers —
it never queues on the gate. Fix one by passing the open transaction down (the
`exec` parameter; a nested `tx.transaction()` is a savepoint and takes no
connection) or by running the inner work after the commit (`afterCommit(tx, …)`,
or after the `await db.transaction(…)` returns). Sequential and sibling
transactions are fine, and so is detached work that outlives its transaction (the
outer lease is released by then). Interactive transactions take no lease and are
not checked.

Transaction hold-time is bounded by two halves of one guardrail: the
`database/no-pool-await-in-transaction` ESLint rule (no awaiting the pool inside a
transaction-scope callback — hold-and-wait), and the **required** `exec` parameter on
query helpers like `listBlockingDepIds`, which turns the transitive version of that
leak into a tsc error.

A "transaction scope" is not only `db.transaction(cb)`. A domain may wrap one
behind its own chokepoint whose callback binds a CONTEXT object rather than the
executor — `withPageForest(scopes, cb)`, the page editor's forest-write lock,
where the executor is `ctx.tx`. Those live in the rule's `TX_SCOPE_OPENERS`
table; **add a line there when you introduce another**, or the rule goes silently
blind inside it. The branded-executor half has a worked example there too:
`PageForestTx` is mintable only by `withPageForest`, so an unlocked forest write
is a tsc error (`plugins/page/plugins/editor/CLAUDE.md`).

Gating at the query (rather than around whole loader bodies) puts the gate on the
actual scarce resource — held connections — so an in-memory loader that issues no
query never waits. (It replaced an older semaphore that wrapped whole loader
*bodies* in `server-core/core/resources.ts`.) Waits are charged to the enclosing
entry so `work = total − Σwaits` stays readable per span; the pool's own
`[acquire]` (connect) and `<sql>` (execute) leaf spans remain.

See `research/2026-07-09-global-interactive-lane-origin-based-db-gating.md` and its
forensic companion `research/2026-07-09-global-interactive-lane-under-load.md`; also
`research/2026-06-19-global-live-state-unified-read-path-v2.md` (Task 2) and
`research/2026-06-19-global-wait-attribution-instrumentation.md`.

## No idle window inside a transaction: `writeAtomically`

Between two statements of a transaction the server sits `idle in transaction`,
holding every lock the first one took, while the app makes its next round trip;
an app that stalls or loses its connection there queues every writer of those
rows behind a session waiting on nobody (the 2026-11-03 incident). So a group of
writes that read nothing in between is **one statement**, never a transaction:
`writeAtomically(exec, [w1, w2, …])` (server barrel) composes drizzle
insert/update/delete builders (or ``sql`INSERT …` ``; `null` skips one) into a
data-modifying CTE, `WITH w0 AS (…), w1 AS (…) SELECT 1` — atomic, one round
trip, every arm firing its own triggers, foreign keys checked at the end of the
statement (a child arm may reference a sibling arm's parent). What one statement
asks of its arms (pinned in `write-atomically.test.ts` on real Postgres): every
arm sees the snapshot from before the statement; no row is touched by two arms,
and a key deleted by one arm cannot be re-inserted by another; all arms share
65 535 bind parameters.

**Enforced** by `database/no-pure-write-transaction`: a `db.transaction`
callback that awaits two or more writes on `tx` (a write in a loop counts as
several) whose results are discarded, and nothing else, is an error. It stays
silent on any transaction that also awaits a read, a used result, a lock or a
helper handed `tx` — the cases a transaction exists for. A batch whose atomicity
something else already gives (the chord song index's load-phase row) needs no
transaction at all; same-shaped rows are one multi-row statement.

## Runbook: a database wedged by a lock chain

Symptom: pages hang on "Waiting for the server…", `db.jsonl` shows
`[deadline]` lines even for trivial SQL, the health report's Database row says
"Blocked now: <origin> holds N sessions" (`database/lock-watch`), and
`db-lock-holder` / `db-query-deadline` reports name the caller.

Look, read-only (`query_db`, or `psql` on the cluster's socket), at the
database's sessions:

```sql
select pid, state, wait_event_type, wait_event, xact_start, query_start,
       pg_blocking_pids(pid) as blocked_by, left(query, 120) as query
from pg_stat_activity where datname = '<database>' order by xact_start;
```

The blocker heads a chain: a session that others wait on with
`wait_event_type = 'Lock'`, itself `idle in transaction` (its client stopped
talking mid-transaction) or `active` on something slow. The leading
`/* origin=… */` comment of its `query` names the code that opened it.

Since 2026-11-04 a lost connection is closed, so a chain built of LOST calls
clears by itself: a client whose call misses its 60 s deadline closes its
connection, Postgres rolls that transaction back, and the cluster's
`client_connection_check_interval` cancels a closed waiter's lock wait within
10 s. What the deadline does not cover is a head whose client is alive but not
talking: `idle in transaction` with no call pending — the app holding a
transaction open between two statements (awaiting something else, or wedged
in its own code). That one is BOUNDED by the cluster's
`idle_in_transaction_session_timeout` (5 min, `database/embedded`): Postgres
ends the session and rolls it back, and the reap files a
`db-idle-transaction-ended` report naming the origin (`database/lock-watch`).
So a chain whose head is idle clears within 5 min, and the report is where to
start. What neither bound covers: a head `active` on something slow, a caller
under a long `withQueryDeadline` bound (boot DDL: 15 min), or a connection
built outside `database/connection` (`db-connection/no-raw-pg-connection`
bans one). A chain standing for more than 5 min is one of those: the origin
names the code — fix that, then free the database.

Why a bound and not only a report: an idle transaction holds its row locks
and a lane slot; a migration altering a table it touched — even only read —
waits on it (and queues every other statement on that table behind its own
lock request), so main's next boot could reach the 15-min boot-DDL bound and
fail to deploy; and if it wrote, its xid pins the live-update watermark
(`snapshotWatermark`) of EVERY database on the cluster, xids being
cluster-wide (all measured 2026-11-04). 5 min keeps all three short.

To free it now: end the **whole chain** older than the deadline — the head and
every waiter — not only the head:
`select pg_terminate_backend(pid) from pg_stat_activity where datname = '<database>' and xact_start < now() - interval '60 seconds' and (pid = <head> or <head> = any(pg_blocking_pids(pid)))`
(repeat while waiters remain). Ending only the head hands the lock to the next
waiter, which finishes its statement and, if its client is gone, sits idle in
its transaction in turn — what happened on 2026-11-03, when every waiter had
been abandoned. Or restart the backend that holds the sockets (a push to main
does it): its connections close, and Postgres rolls every one of them back.
`query_db` is read-only, so terminating needs a superuser session on the
cluster's socket.

## Import-safety (lazy pool)

Importing `@plugins/database/server` has **no side effects** and never asks for
this process's runtime namespace. The pg pool is built by a lazy `pool()` singleton on the
first real query/connection; `db` is a thin forwarding Proxy over a
lazily-constructed real drizzle instance (`machine/internal/pg-driver.ts`, behind `server/internal/driver.ts`'s Proxy). A missing
worktree stays **loud** — the first `db.<method>()` (or `awaitDbReady`/`warmPool`)
throws out of `runtimeNamespace()` — but the throw no longer fires
at module eval. This is what lets any `bun:test` transitively import a server
module near the DB and inject a fake `db` without a per-suite env shim. The Proxy
forwards to a **real `pg.Pool`-backed** drizzle instance (not a fake), so
`db.transaction()` — which drizzle gates on `client instanceof Pool` — keeps
working. Do not reintroduce an eager `new Pool(runtimeNamespace())` at module top.

The lazy pool keeps *import* safe; a **`bun test` preload** (`test/bun-preload.ts`,
registered in the root `bunfig.toml` `[test]` section) then declares the current
checkout as the test process's runtime namespace, so a suite that issues a real
query — or that touches any other namespace-scoped throw (the per-worktree log
dir, config_v2) — runs with a plain `bun test <path>` and nothing set in the
environment. The throws stay loud in production; only test runs get the default.

## Bootstrap

Before the schema layer, the barrier takes this process's schema-generation lock
(`DatabaseDriver.holdSchemaGeneration`), and the schema layer defers the last
phased group's contract; `onReady` runs it once no older code is connected
(`server/internal/deferred-contract.ts`; see `migrations/CLAUDE.md`, "The
contract is deferred until the old code is gone").

`awaitDbReady` + `applySchemaLayer` (migrations and the derived layer — derived `updatedAt` triggers, rollup tables, views — in ONE transaction; see `plugins/database/plugins/derived-views/CLAUDE.md` and `research/2026-09-29-global-phased-migrations.md`) are called in the database plugin's `onReadyBlocking` hook. Derived inputs are read at that call site and passed in, never read inside the layer. `onReadyBlocking` is a hard barrier the framework awaits in full before flipping the server-ready flag and before any plugin's `onReady` runs — so consumers can safely use the DB in their own `onReady`, and the gateway holds its hot-swap until the schema layer has committed. (Previously this lived in `onReady`, where it raced other plugins' `onReady` and the gateway swap until migrations happened to be slow.)

## Import paths

```typescript
// Drizzle instance, pools, helpers
import { db, pool, adminPool, awaitPgReady, connectionString } from "@plugins/database/server";

// Embedded Postgres constants
import { ... } from "@plugins/database/plugins/embedded/server";
import { ... } from "@plugins/database/plugins/embedded/shared";
```

## Schema change workflow

Edit `plugins/{name}/server/internal/tables.ts` → run `./equin build`. The build regenerates migrations and restarts the server, which applies them via the `onReady` hook. Never run `drizzle-kit generate` or the migration runner directly.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Core database infrastructure: the app's `db` over the host's DatabaseDriver, DB readiness and the boot schema layer.
- Load-bearing: yes
- Server:
  - Contributes: `host-service:database.driver` "database.driver"
  - Uses:
    - `database/db-triggers.DbTrigger`
    - `database/db-triggers.DbTriggerClaim`
    - `database/derived-tables.DerivedTable`
    - `database/derived-tables.publishReconciledRollups`
    - `database/derived-updated-at.registeredDerivedUpdatedAt`
    - `database/derived-views.View`
    - `database/migrations.applySchemaLayer`
    - `database/migrations.completeDeferredContract`
    - `database/migrations.generationsKnowing`
    - `database/migrations.MigrationSource`
    - `database/migrations.schemaGeneration`
    - `database/migrations.SchemaLayerInputs`
    - `primitives/log-channels.defineLogSink`
  - DB schema: `plugins/database/server/internal/boot-schema.ts`
  - Exports (types):
    - `AtomicWrite`
    - `DatabaseDriverImpl`
    - `Db`
    - `DbExecutor`
    - `ListenHandlers`
    - `ListenSession`
  - Exports (values):
    - `afterCommit`
    - `currentTxId`
    - `DatabaseDriver`
    - `db`
    - `dbLog`
    - `isTransientDbError`
    - `loadKnownRelations`
    - `quotedRelationsIn`
    - `readTag`
    - `schemaChangedAtBoot`
    - `snapshotWatermark`
    - `writeAtomically`
- Machine:
  - Uses: `database/pgbouncer.convergePgbouncerConfig`
- Core:
  - Uses: `packages/timed-fs.readFileSync`
  - Exports (types):
    - `DatabaseConfig`
    - `DatabaseProvider`
  - Exports (values):
    - `buildConnectionString`
    - `DATABASE_CONFIG_PATH`
    - `libpqEnvSync`
    - `readDatabaseConfigSync`
- Cross-plugin:
  - Imported by: 152 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×42
    - `conversations` ×17
    - `infra` ×15
    - `page` ×14
    - `tasks` ×14
    - `active-data` ×8
    - `debug` ×7
    - `database` ×5
    - `primitives` ×4
    - `network` ×3
    - `stats` ×3
    - `backup` ×2
    - `build` ×2
    - `framework` ×2
    - `reports` ×2
    - `apps-core/app-usage`
    - `code-explorer`
    - `hints`
    - `history/engine`
    - `integrations/google-maps/usage`
    - `plugin-meta/plugin-health`
    - `release`
    - `search/engine`
    - `shell/notifications`
    - `tag-tree/engine`
    - `ui/theme-engine/saved-themes`
    - `wish`
- Exemptions:
  - Exempts itself from:
    - `boundaries/no-platform-api` — `core/internal/config.ts` (debt)
    - `blocking-fs/no-sync-fs` — `machine/internal/pg-driver.ts` (debt)
- Test helpers:
  - Server: `@plugins/database/server/testing`
    - `snapshotWatermark`
  - Machine: `@plugins/database/machine/testing`
    - `createLanePools` — Build both lane pools for one database, the wrapper installed.
    - Types: `LanePools`
- Sub-plugins:
  - **`admin`** — Admin operations for the database plugin — fork, backup, drop, list.
  - **`client-tools`** — Postgres client tools (pg_dump, pg_restore) built from the same release as the embedded server: pgClientBin resolves the vendored binary, never the PATH.
  - **`connection`** — Every backend database connection, built one way: createDbPool / createDbClient give each pool or standalone client a name from the closed pool-name set and a pg.Client subclass that bounds…
  - **`db-test-fixture`** — Shared throwaway-database fixture for DB-backed test suites.
  - **`db-triggers`** — The one trigger installer: defineDbTriggers names a set of plpgsql functions and the triggers that call them (asserted at module eval to create what they are named, schema included), contributed as…
  - **`derived-tables`** — Trigger-maintained materialized rollup tables as data: defineRollup generates a rollup's table, a maintain function and triggers per source (diffing the columns it reads, advisory-locked per key)…
  - **`derived-updated-at`** — Derived updatedAt: compiles a table's per-column touchedBy rules (declared in defineEntity's meta.updatedAt, or deriveUpdatedAt on a raw pgTable) into a BEFORE UPDATE trigger that sets updated_at =…
  - **`derived-views`** — Rebuilds plain DB views from source on every boot, in dependency order. Plain views are derived code (declared via the View contribution), not stateful migration schema.
  - **`embedded`** — Embedded Postgres binaries for the gateway-owned cluster. Provides shared connection constants used by every worktree backend.
  - **`fork`** — Durable, self-healing worktree DB fork: a graphile job that forks the base DB per worktree (idempotent, atomic), plus a scheduled sweep of orphaned temp forks.
  - **`fork-point`** — Reads when this database was forked from another (databaseForkedAt): the instant the fork stamped on it, or null for a database never forked.
  - **`lane-isolation`** — The end-to-end proof that the app's connection lanes are isolated all the way down to PgBouncer: with every background server slot of a throwaway database held idle in a transaction (the 2026-11-03…
  - **`lock-watch`** — Database lock watch: a per-worktree job that looks at pg_stat_activity + pg_blocking_pids once a minute (Postgres has no change signal for lock waits), on a held direct session that neither a…
  - **`migrations`** — DDL lifecycle: migration runner and SQL files.
  - **`pgbouncer`** — PgBouncer connection pooler for the embedded Postgres cluster: path constants for connection routing, and this machine's config rendered from the lane table (one server pool per connection lane).
  - **`pglite`** (excluded) — The PGlite database driver: provides the DatabaseDriver host service with Postgres compiled to WASM, for a host without the computer's Postgres cluster (the browser composition, the portable boot…
  - **`query`** — MCP tool for agents to query worktree databases for debugging and inspection.
  - **`query-deadline`** — Query-deadline presence: the health report's Database row (attention while a database call on any pool got no reply in the last 10 minutes, naming the latest's pool and caller, read from the…
  - **`sql-column`** — Decoded columns: `parsedText` / `parsedJson` derive a column's type from a zod schema that really decodes it — on every read and every write — so a column can no longer declare a string-literal…
  - **`sql-projection`** — Mapped raw-SQL projections: `parsed` / `nullable` turn a schema or a column into the decoder drizzle's `.mapWith()` derives a projection's type from, so a `sql` expression selected as a value can no…
  - **`sql-rows`** — Parsed raw-SQL row reads: queryRows / executeRows parse every row against a zod schema and throw a SqlRowError naming the column, the value and its Postgres type OID — closing the pool.query<T>()…

<!-- AUTOGENERATED:END -->
