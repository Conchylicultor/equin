# 02 — Database Layer: Cluster, Pools, Migrations, Change Detection

> Part of the [communications audit](./00-overview.md). This file covers
> everything between Postgres and the server processes: the embedded cluster,
> connection routing, schema lifecycle, per-worktree forks, and the two
> DB-side halves of the live-state stack (the L4 change-feed and the L2
> snapshot store).

## 1. The embedded cluster (`database/plugins/embedded`)

One **Postgres 18** cluster per machine, binaries vendored via
`@embedded-postgres/*` packages, data dir `~/.singularity/postgres/data-pg18`.
The gateway's service supervisor runs `scripts/start.ts`, which:

- `initdb -A trust --no-locale --encoding UTF8` on first run,
- `pg_ctl start -w` with `max_connections=500`, `listen_addresses=127.0.0.1`,
  `wal_level=logical` — the last two exist *specifically* for the Zero pilot
  (logical replication needs TCP + logical WAL),
- probes pidfile + socket first so a fresh gateway **reattaches** to a
  running cluster instead of double-spawning.

Isolation model: **one database per worktree inside the shared cluster**
(named by attempt id), plus the main `singularity` DB. Not one cluster per
worktree — forks are cheap `pg_dump | pg_restore` copies, and one cluster
means one supervisor, one port, one backup surface.

## 2. Connection routing: PgBouncer vs direct

Two deliberate paths, chosen per connection *kind*:

| Path | Who uses it | Why |
|---|---|---|
| **PgBouncer :6432** (transaction pooling, `default_pool_size=16`, catch-all `* =` DB routing) | The app pool: `db = drizzle(pool)`, every loader/handler query | 1000+ potential worktree backends × 16 connections each would exhaust `max_connections`; transaction pooling multiplexes them. Catch-all routing means creating/dropping a worktree DB needs no pooler reconfigure. |
| **Direct :5433** | change-feed `LISTEN`, graphile-worker, `adminPool`, `pg_dump`/`pg_restore` subprocesses, zero-cache replication | All of these are session-bound (LISTEN registrations, advisory locks, walsender) — transaction pooling would silently break them. |

### The app pool (`database/server/internal/client.ts`)

- `Pool({ max: 16, idleTimeoutMillis: 20_000 })`.
- **Loader admission gate**: `RESERVED_INTERACTIVE = 6` connections are always
  kept free for HTTP/mutation work; loader-kind queries (identified from the
  profiler's ambient caller context) go through a `createSemaphore(10)`.
  Prevents a live-state recompute storm from starving interactive requests.
  A slot is held per *query*, not per loader body — an in-memory loader that
  issues no SQL never waits.
- `pool.query` is patched to record two profiler spans per query —
  `[acquire]` (checkout wait) and the SQL itself — so contention is visible
  and correctly attributed. This same chokepoint is where **L3 read-set
  capture** records `table → loader` edges (see [04-live-state](./04-live-state.md) §5).
- Deadlock (`40P01`) / serialization (`40001`) failures retry up to 4× with
  jittered backoff — exists because derived-view rebuilds take brief
  `AccessExclusive` locks during hot restarts.
- Boot: `awaitDbReady()` (SELECT 1 with 30s deadline) → `warmPool()` (eagerly
  opens all connections; node-postgres `min` does not pre-connect) →
  `runMigrations` → `rebuildDerivedTables` → `rebuildDerivedViews`, all
  sequenced inside the database plugin's single `onReadyBlocking` hook
  because hook order across plugins is otherwise not total.

## 3. Schema lifecycle (`database/plugins/migrations`)

- **Declaration**: each plugin owns `plugins/<name>/server/internal/tables.ts`
  (+ `schema.ts` for zod/views). drizzle-kit discovers them by glob — there is
  no central schema aggregator; adding a plugin's tables touches no shared file.
- **Generation**: `./equin build` runs `drizzle-kit generate`; output is
  renamed `YYYYMMDD_HHMMSS_<sha8>__<slug>.sql` and committed. Data/backfill
  migrations are scaffolded empty (`--custom-migration`), have no snapshot
  (so they can't Y-fork the snapshot chain), and re-apply exactly once per DB
  because the ledger keys on content hash.
- **Application**: every backend boot runs the runner: ensure ledger table →
  read applied hashes → apply each pending file in its own transaction,
  inserting its hash in the same transaction. Applied-ness lives **only** in
  the DB ledger (`__singularity_migrations`), never inferred from files.
- **Safety check**: `migration-applies-clean` (pre-push) replays the pending
  delta against live main in one transaction with lock/statement timeouts and
  **always rolls back** — catching "works on my fork, breaks on main" drift
  before merge.
- **Fork interplay**: forks copy the ledger with the data, so a fresh fork
  no-ops the runner; only migrations landed on main *after* the fork execute
  in the worktree.

## 4. Per-worktree DB forks (`database/plugins/fork` + `database/plugins/admin`)

Flow when an agent worktree is created:

1. `conversations` (on attempt creation) enqueues `databaseForkJob` —
   `defineJob("database.fork", { dedup: { key: target } })`. The enqueue is a
   committed graphile row: if the backend dies mid-fork, the job re-runs on
   reboot instead of leaving a half-created DB.
2. `forkDatabase(source, target)` is **idempotent** (no-op if target exists)
   and **atomic-publish**: restore into `<target>__forking`, then
   `ALTER DATABASE … RENAME` as the last step — the canonical name only ever
   exists fully-formed. Mail's bulk tables are schema-only-copied (data
   excluded) because an 800MB Gmail corpus made forks interruptible-slow.
   The copied `graphile_worker` schema is dropped (a forked crontab would
   silently skip runs).
3. A scheduled sweep (`database.fork-temp-sweep`, every 15 min) drops
   orphaned `*__forking` temps that have zero active connections.

This is the pattern the whole codebase repeats: **durable job + idempotent
body + atomic publish + orphan sweep**.

## 5. L4 — the change-feed (`database/plugins/change-feed`)

The mechanism that makes the DB itself the invalidation bus.

### Write side (in Postgres)

`rebuildTriggers(db)` runs on **every boot** (deterministic DDL, not a
migration): for every `public` table not in the denylist, it installs three
**STATEMENT-level** triggers (INSERT/UPDATE/DELETE, `REFERENCING NEW/OLD
TABLE`) calling one shared plpgsql function `live_state_notify(pk_col)`:

- skips silently if the statement touched 0 rows,
- aggregates changed single-column PKs into `ids text[]` (composite/no-PK
  tables → `ids = NULL` → FULL-for-table),
- `pg_notify('live_state', {t, op: I|U|D, ids})` — payload capped ~7KB;
  above that, ids are dropped (degrade to FULL),
- **atomically inserts into `live_state_changelog (seq, xid, t, op, ids, at)`**
  with `xid = pg_current_xact_id()` — the durable outbox. Because it's the
  same transaction as the data write, a rollback leaves no changelog row, and
  a commit can never be missed by a down server.

Statement-level (not row-level) keeps bulk writes cheap: one trigger firing
per statement, with the transition table providing the affected rows.

Denylist: the ledger + changelog/snapshot tables themselves (recursion),
trigger-maintained rollups from `derived-tables` (already covered by their
source tables), and explicit `ExcludeFromChangeFeed({ table, reason })`
opt-outs (reason mandatory — an excluded table's UI degrades to
hydrate-on-mount, which must be a reviewed decision).

### Read side (in the backend)

A **dedicated raw `pg.Client`** (direct, non-pooled — LISTEN is
session-bound) does `LISTEN live_state`:

- capped exponential reconnect (500ms→10s) + a 30s liveness watchdog,
- on **reconnect** (never first boot) runs `fullSweep()` — FULL-invalidates
  every covered table, defense-in-depth for notifications missed while the
  socket was down,
- each payload → `parseLiveStatePayload` (strict, non-throwing) →
  `routeChange(change)`.

`routeChange` is the single routing function shared by the live path **and**
the L2 catch-up replay (so "catch-up ≡ replay as if live" holds by
construction). It applies the change to the base table, then to every *view*
transitively built on it — forwarding scoped ids only through 1:1
PK-preserving views, degrading to FULL otherwise. From there,
`applyDbChange()` in the resource runtime takes over
([04-live-state](./04-live-state.md) §5).

## 6. L2 — persisted materialization (`database/plugins/live-state-snapshot`)

Table: `live_state_snapshot(resource_key, params_key, value jsonb,
position numeric, tables_read text[], updated_at)`.

- **What persists**: only boot-critical resources (read generically off
  `Resource.Declare` contributions — no hardcoded names).
- **When**: on every successful FULL recompute of such a resource, the runtime
  persists `{value, watermark, tablesRead}`. The watermark is
  `pg_snapshot_xmin(pg_current_snapshot())` captured **before** the loader's
  first read, so any write invisible to that loader has `xid >= position` —
  catch-up can over-replay (harmless, idempotent) but never under-replay.
  `tables_read` is the loader's captured read-set, persisted so a cold boot
  can seed the table→resource index with **zero loader executions**.
- **Cold boot**: `runCatchUp()` takes `min(position)` across snapshots and
  replays every `live_state_changelog` row with `xid >= floor` through
  `routeChange`. If the changelog was pruned past the floor (server down too
  long), it FULL-recomputes every table seen in the retained changelog and
  logs loudly. Ordering invariant: catch-up runs strictly *after* LISTEN is
  established, so nothing lands in the gap.
- **Payoff**: the boot-snapshot endpoint serves all boot-critical values from
  one batched SELECT (low ms), and the browser paints real data before any
  loader has run. A scheduled prune job bounds changelog growth.

## 7. Derived state: `derived-views` and `derived-tables`

Both are **rebuilt from source on every boot** rather than migrated — because
drizzle-kit emits view DDL alphabetically (not dependency-ordered) and
because derived state is *code*, not schema history.

- **`derived-views`**: plugins contribute `View({ view, dependsOn?,
  identityTable? })`. Boot topologically sorts, computes a sha256 signature
  of the compiled DDL, and skips the whole DROP+CREATE cycle when unchanged
  (removing the AccessExclusive-lock window from steady-state restarts).
  `identityTable` marks a view as 1:1 PK-preserving so the change-feed can
  forward scoped ids through it.
- **`derived-tables`**: hand-rolled incremental view maintenance for rollups
  too hot to recompute live (currently one: conversations/agents). A
  contributor supplies four opaque DDL blobs (create / function / triggers /
  reconcile); the generic layer orchestrates rebuild inside the change-feed's
  own trigger-rebuild transaction — which conveniently guarantees the rollup
  never gets a NOTIFY trigger (it doesn't exist yet when the trigger set is
  snapshotted) and is instead covered by its *source* tables' triggers.

## 8. Typed storage primitives (`infra/entities`, `infra/entity-extensions`)

- **`defineEntity(name, fields, meta)`** derives a Drizzle `pgTable` **and** a
  zod wire schema from one `FieldsRecord`, so `table.$inferSelect ≡
  z.infer<schema>` by construction — column/wire drift becomes a tsc error.
  Nullability derives from the field's zod schema; DB defaults and FKs are
  explicit opt-in metadata. Currently proven on one fixture table
  (`slow_ops`); migrating live tables is the roadmap's Stage D.
- **`defineExtension(parentTable, name, columns)`** gives a *child* plugin a
  1:1 side-table `<parent>_ext_<name>` (PK = FK CASCADE to the parent) so it
  can attach state without touching the parent's schema — the inverse
  dependency would otherwise couple e.g. `tasks` to every feature that
  annotates a task. 16 consumers (task-effort, task-preprompt, auto-start,
  pages/starred, sonata extensions, …). Only the typed handle
  (`upsert/get/delete`) crosses the plugin barrel; the raw table stays
  internal, enforced by the boundary checker.

## 9. Debug/inspection surface

- **`query_db` MCP tool** (`database/plugins/query`): agents run read-only SQL
  against any worktree DB. Enforced at the DB level: fresh 1-connection
  client, `BEGIN TRANSACTION READ ONLY` + 5s `statement_timeout`, ROLLBACK
  always (even on success), 200-row cap.
- **Zero pilot** (`database/plugins/zero`): see [07-side-channels](./07-side-channels.md) §7.
