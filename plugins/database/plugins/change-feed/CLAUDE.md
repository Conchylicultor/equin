# change-feed

## The trigger rebuild: fingerprint fast-path, then single-relation transactions

`rebuildTriggers` (`internal/triggers.ts`) installs the feed by `DROP+CREATE
TRIGGER`ing every non-excluded public table. Boot is the worst possible moment to
hold table locks:

- the **previous backend is still serving reads** of those same tables (the
  hot-swap is ready-gated — it does not stop until the new backend is ready,
  holding `AccessShare` locks throughout), and
- this hook runs alongside the database plugin's own `onReadyBlocking` (migrations
  → rollup reconcile → view rebuild): `onReadyBlocking` hooks run under a flat
  `Promise.all` with no topo order.

### Fast-path: skip what is unchanged, per object

Mirroring the fast-path in
[`derived-views`](../derived-views/server/internal/rebuild.ts): the trigger layer
is a pure function of (schema, denylist, routed layouts, emitted DDL), so its
compiled DDL is fingerprinted into `live_state_trigger_state` — **one row per
object**: a row per triggered table (the hash of its compiled statements) and one
for the shared layer (the two notify functions and the changelog DDL, under the
empty name). `planRebuild` compares each against the desired one and **rebuilds
only what differs**. A steady-state restart — the overwhelming majority of boots,
since any frontend-only commit leaves the trigger set untouched — takes **zero
table locks**; a new table, a dropped exclusion or a route's changed layout locks
exactly the tables whose triggers change. (The first design stored ONE
whole-layer signature, so any one change rebuilt all ~200 tables, each taking an
exclusive lock in turn during the hot swap — and routes change layouts far more
often than the schema changes. A state table still in that one-row shape is
replaced, which costs one rebuild of every table.)

**A signature is never trusted alone.** `planRebuild` re-verifies from the catalog
that both functions, the changelog and the end marker (its function and its
deferred trigger) exist, that each table's three triggers are
physically present, and that no `live_state_*` trigger lingers on an excluded
table. Anything dropped out of band is rebuilt. (It reads only catalogs — no
user-table locks, which is the whole point.)

The signature rows live in the DB so a worktree fork carries them with its
triggers (`CREATE DATABASE … TEMPLATE` copies both), so a fork skips the rebuild
too rather than paying a spurious first-boot one.

### The real rebuild: one transaction per relation (deadlock impossible)

When a rebuild *is* needed, it is **never** one transaction over the whole schema.
The old design `DROP+CREATE TRIGGER`d every table in **one** transaction, so
mid-rebuild it held `AccessExclusive` locks on an alphabetically-ordered prefix of
the database *while still asking for more* — textbook hold-and-wait. During the
hot-swap the old backend's reads lock those same tables in the opposite order,
closing a lock cycle; Postgres shot the rebuild transaction, the error escaped
`onReadyBlocking`, and the deploy failed leaving the old code live (build
`build-1784288281433-w62dep` died exactly this way: `attempts` ⇄ `conversations`,
SQLSTATE `40P01`).

The fix is structural: **the rebuild is split so no transaction ever holds more
than one relation's exclusive lock.** A transaction that only ever locks one
relation cannot be a node in a wait cycle — it acquires that one lock or blocks on
exactly one holder (an old-backend reader, which is not itself waiting on us for a
second relation). The wait-for graph is a forest by construction; **the deadlock
is impossible, not retried** (there is no `lock_timeout`, no retry loop). A
per-table tx can still *block* briefly on a live reader's `AccessShare` lock, but
the old backend's reads are short (ms), so this is a wait, not a hang.

The tables it must skip beyond its own plumbing — derived-table rollups and
`ExcludeFromChangeFeed` opt-outs — are contribution sets, so `rebuildTriggers(db,
exclusions)` takes them as an argument (`TriggerExclusions`): the boot hook reads
them (contributions are collected by then), and a suite on a throwaway database
passes its own (`getContributions` throws in a process that never booted).

The rebuild runs in two phases, each step its own `db.transaction`:

1. **Prelude tx** (only when the shared layer changed or lost an object) —
   `ensureChangelogTable` + `CREATE OR REPLACE FUNCTION live_state_notify` /
   `live_state_notify_routed` / `live_state_txn_end` + the end marker's trigger
   on the changelog (only when missing or different) + the layer's signature. The functions must exist
   and be committed before any trigger references them. None of it takes a
   user-table lock, and `ensureChangelogTable` touches the changelog only for a
   piece the catalog says is missing: every trigger on every table INSERTs into
   the changelog, and `ALTER TABLE … ADD COLUMN IF NOT EXISTS` (ACCESS EXCLUSIVE)
   or `CREATE INDEX IF NOT EXISTS` (SHARE) lock it even when there is nothing to
   do — behind one open writing transaction, every writer in the database would
   queue on that lock request.
2. **Per-relation txs** — one transaction **per changed table**: its full
   `DROP…IF EXISTS` + `CREATE` set for all three ops, plus the upsert of its own
   signature row; for each stale (now-excluded) table still carrying
   `live_state_*` triggers, just its drops and the deletion of its row. Each
   touches exactly one table. Rows of tables that no longer exist are deleted
   last (bookkeeping, no table lock).

Three self-healing invariants make this safe:

- **No object is ever half-built.** Each table's `DROP…IF EXISTS` + `CREATE` is in
  one tx, so the table always has a *complete* trigger set — old or new, never
  none. The notify functions are committed first, so old and new triggers both
  call the current function. **No feed event is lost**: a write mid-rebuild fires
  whichever trigger version is installed, and both emit a compatible NOTIFY
  through the same committed function.
- **A signature is exactly what is installed.** Each object's signature is
  stamped IN the transaction that installs it, and is trusted only alongside the
  catalog re-verify. A boot that dies anywhere leaves each object either rebuilt
  and stamped, or untouched with its old stamp — the next boot rebuilds exactly
  the rest, and a rolled-back deploy finds each table's stamp matching what is
  really there.
- **Partial state is "old-but-working," never "broken."** The only thing lost vs.
  one-big-tx is "all tables flip in the same instant," which nothing consumes
  (triggers are independent, all call the same function). Worst case is a loud
  error on a concurrent write, self-healed next boot — never silent corruption.

## The routed trigger layout (P3)

A table a compiled route reads gets a richer trigger than the PK-only feed
(`research/2026-09-29-global-scoped-change-routing.md` P3). Its layout is
DERIVED from the routes — server-core's `routedTableRequirements()`, read once in
`onReadyBlocking` (resources register at module eval, deferred ones bind right
after contributions are collected, both before this barrier) and handed to
`rebuildTriggers(db, exclusions, requirements)`:

- **carry** — every column a route maps through, filters by (`rows`) or lets a
  tuple match on (`match`): a custom value's `row_key`, `data_view_id`,
  `column_id`. The trigger emits them as `keys`, DISTINCT over the rows the
  statement touched, row-wise (`{ "c": [columns], "r": [[values]] }`, so the
  columns stay aligned); `parse-payload` turns that into the router's columnar
  `TableChange.keys`.
- **gate** — the columns an UPDATE compares old against new: the union of the
  `columns` of every route that reads FEWER columns than the table has (the
  requirement's `reads`, one set per route), on a single-column-PK table. Only
  such a route can be skipped, so a column only whole-table readers read is
  never compared (a `body_html` would be detoasted and compared on every
  UPDATE to skip nothing). The events list's lookup reads `id, type, config,
  enabled` of `event_sources`, which the sources collection lists whole; a
  sources grouping's narrow route reads `status` too, so the gate is `config,
  enabled, id, status, type`, and a run's `status` write leaves the lookup's
  four columns `unchanged`, which skips it. An UPDATE
  then sends `unchanged`, the gate columns whose value is EQUAL in every row
  (old and new joined on the PK, compared as text — json has no equality). It
  is a fact about the rows, whatever the gate: a column not compared is not
  listed, so the router reads it as possibly changed — soundness never depends
  on the gate. A PK that moved makes the pairing unknown: `unchanged` is NULL
  (nothing known). `[]` means every compared column moved.
- **old ∪ new** — the UPDATE trigger declares `OLD TABLE AS old_rows` too, so
  `ids` and `keys` cover both sides: a key-changing UPDATE names its old host as
  well as its new one. A DELETE's keys come from `old_rows`.
- **over the cap** (a payload past 7000 bytes) `ids` and `keys` drop (FULL for
  the readers, as before), while `unchanged` — column names, bounded by the
  gate whatever the row count — stays, so a bulk write of a column no route reads still
  reaches nothing. Only if the payload is still over the cap does it drop too.
- The function is `live_state_notify_routed(pk, carry_json, gate_json)`, created
  beside `live_state_notify()` in the prelude. **Every other table's trigger is
  byte-identical to the PK-only feed's** — DDL (`compileTableTriggerDdl` with no
  layout) and payload (`{t, op, ids, x, at}`), pinned by `routed-trigger.test.ts`.
  A routed table's layout rides its trigger arguments, so a changed layout changes
  that table's compiled statements and signature: that table alone is rebuilt.
- **`live_state_changelog` gains `keys jsonb` and `unchanged text[]`** (created
  with the table, and ALTERed into an older one once — only when the catalog
  says they are missing), written by the routed function with the post-cap
  values it NOTIFYs.
- **A malformed layout routes unscoped, on both paths.** `readLayout`
  (`parse-payload.ts`) is the one rule the listener and the L2 catch-up apply:
  a `keys` or `unchanged` that does not parse makes the change unscoped (`ids`,
  `keys`, `unchanged` all null — FULL for its readers) and is reported, never
  dropped — the table and op are known, and a dropped change is stale data.
- **The catch-up replays `unchanged` as written.** A catch-up follows a restart
  that may have changed the routes, and that is fine: `unchanged` names only
  columns KNOWN equal, whatever gate compared them, so a route reading a column
  the old gate did not compare is still reached. `keys` replay as written too:
  a column the old layout did not carry reads as unknown, which recomputes
  rather than skips.
- `resolveLayout` checks the requirement against the catalog: a carried or read
  column the table does not have throws (boot fails loudly, never an unscoped
  route).
- **A3** (`internal/route-layout.ts`, after the rebuild, both paths): every routed
  table's three installed triggers — read back from `pg_trigger.tgargs` — are the
  routed function keyed on the table's own single-column PK ('' for a composite
  one), carrying every required column. Anything else blocks boot. The gate is
  not checked: whatever it holds, `unchanged` lists only columns it compared
  and found equal, so a narrower gate only skips less.

## Boot-time reconciliation against consumers

The feed enforces its invariants against its consumers at boot (in
`onReadyBlocking`, after triggers are installed — `installFeed` lists them all) —
not via a static
`./singularity check`, because neither can reach a live DB nor the server-only
contribution/registry sets:

- **`assertNoOtherDeferredTriggers`** (`internal/txn-end.ts`) — **throws** if a
  deferred or deferrable trigger other than the end marker sits on a triggered
  table or on the changelog (see the end marker, below).
- **`warnOnCoverageGaps`** (`internal/triggers.ts`) — warns if any non-excluded
  public table is missing its `live_state_*` triggers (drift signal; should always
  be empty by construction).
- **`assertRouteTablesCovered`** (`internal/route-coverage.ts`, A1 of
  `research/2026-09-29-global-scoped-change-routing.md`) — **throws (blocks
  boot)** if a ROUTED resource (`routes` / `reach`) names a table with **no
  change source** in a route — it is reached only through its route tables, so an
  untriggered side table is as dead as an untriggered base. Such a route is dead
  config that silently degrades the resource to hydrate-on-mount. The single authoritative test is membership in
  `getCoveredTables()` (the set `rebuildTriggers` just installed) — which subsumes
  the `ExcludeFromChangeFeed` case AND catches the other ways a table ends up
  untriggered: a **VIEW name** instead of its base table (the documented
  resource-runtime footgun; a routed compiler also refuses a view `from`), a
  feed-exempt **derived-table rollup**, or a **typo / dropped table**. A
  legitimate base table is in the covered set by construction, so a miss is never
  a false positive. Each violation is classified (`excluded` / `rollup` /
  `uncovered`) and names the route that declared the table (`route "<id>"`),
  so the error carries the right remediation. It cross-checks the
  resource-runtime's `scopedResourceTables()` (surfaced through `server-core`)
  against `getCoveredTables()` ∪ the produced tables (A1′ — a table fed by a
  change producer has a change source too, see below), using
  `excludedTableNames()` + `feedExemptTables()` only to label the reason. This
  catches hand-written AND compiled resources uniformly, because the check reads
  the runtime's stored declarations, not source text. Fix: point the resource at a
  real triggered base table (not a view/rollup), drop the exclusion, give the table
  a change producer (the precedents: `reports`, `traces`, and `debug/slow-ops`'
  `slow_ops` + `slow_op_callers`, each written one statement per batch with its
  merges in SQL), or serve it as an external `snapshot` live value with a
  Refresh affordance (the precedent: Studio's `sample-rows`, which records its
  Postgres read as a sanctioned `no-db-backed-notify` exemption; a read of a
  table the serving plugin itself excludes needs none). An
  endpoint read on open is not a remedy — `live/no-endpoint-read` flags it as
  debt.
- **`assertNoUnroutedResources`** (D6, `internal/route-coverage.ts`) —
  **throws** first thing in `installFeed` if any DB-backed resource declares no
  reads (`unroutedResourceKeys()`: neither `routes` nor `reach`) — no table
  change would ever reach it. Not refused at registration, since a DB-free test
  resource is legitimately unrouted.
- **`assertRelationBasesSourced`** (D35, `internal/relation-bases.ts`) — **throws**
  if a view or rollup reaches, through its relation bases, a base table with no
  change source that is not opted out (`ExcludeFromChangeFeed`, whose readers
  accept hydrate-on-mount by declaration). A view's reader (a reach plan's
  relation read, or a drifted read failed open) is reached only through those
  bases, so a silent one would freeze it. Known limit:
  a view reading through a function body is invisible to `view_table_usage`.

The boot body lives in `installFeed` (`internal/install-feed.ts`), parametrized
on the database and on the contribution / registry sets, so
`producer-boot.test.ts` runs the real install against a throwaway database.

## Change producers: the in-process change source

A table whose writes are all made by this backend, at a rate where a trigger +
changelog row + NOTIFY per statement costs more than what the table records,
declares a **change producer** instead (`defineChangeProducer`,
`internal/producer.ts`; research/2026-10-01-global-scoped-change-routing-p5-p8.md
P5). The feed installs no trigger on it (`TriggerExclusions.produced`, read from
the mounted `declare` contributions), and its writes route straight into
`routeChange` from the process that made them, tagged `source: "producer"`.

- **The producer owns the write verb.** `mutate(executor, (q, t) => builder,
  { latency })` runs one insert / update / delete builder on the producer's own
  table, appends `RETURNING <pk>` itself and emits exactly the returned PKs (an
  upsert is a `U`, a delete a `D`). There is no `emit` to forget. The executor is
  the pool (`ProducerExecutor` — a transaction handle, which has `rollback()`, is
  a type error), so every producer write is one autocommit statement and its
  emit is after commit. `latency` is required: `interactive` flushes at once.
- **Coalescing at the source.** A pending `Map<id, U|D>` (last op wins), flushed
  once per fixed window armed on the first change — a true rate cap, which the
  runtime's debounce is not. The flush stamps `changedAt` at the flush, not at
  the first buffered emit: the window is a declared delay, so live-state's
  `update` latency sample starts when it closes — and counting it would loop,
  since every produced table is an observability store (a slow `update` of an
  open Slow Events pane is a `slow_ops` write, whose push is late by the window
  again). Deletes route before upserts; over
  `PRODUCER_IDS_CAP` ids the flush routes `ids: null`. The timer and every flush
  run in the root async context captured at module eval, so a writer inside
  `runWithoutProfiling` does not hide the `route` span. Each change of a flush
  routes on its own: a routing throw is filed (`ChangeProducerRouteError`) and
  the rest still route. The window's timer is unref'd, and `onShutdown` drops
  every pending window before the listener stops.
- **Volatile.** No changelog, no NOTIFY: a change still pending at a restart is
  lost. Clients resubscribe and load in full; inside one subscription a lost emit
  heals membership but not the values of rows already in the base.
  live-state-snapshot refuses any L2-persisted reader of a produced table (A6).
  A producer change has no `unchanged` set, so a `:groups` tuple over a
  produced table recomputes its whole aggregate on every flush touching the
  table — bounded by the window, one aggregate per open grouping.
- **Guards.** A12: `mutate` on a producer whose `declare` is not mounted throws.
  A13: `mutate` outside the serving backend (`bootMode !== "serve"`) throws — an
  exec child files through the outbox. A2′: one producer per table (module eval);
  a produced table is neither `ExcludeFromChangeFeed`-ed nor a rollup, and no
  `live_state_*` trigger survives on it (catalog, after the rebuild). A3p: a route
  on a produced table carries no column (a producer emits ids only).
- **A11, the `change-feed:producer-writes` check** (`check/`): a drizzle
  `insert` / `update` / `delete` on a produced table's binding that is not the
  builder a producer's `mutate` callback returns, or a raw SQL write
  (insert / update / delete / truncate / merge) naming the table, fails the
  check. Names are scoped per file — an aliased import, a `const t = _reports`
  re-bind and a `schema._reports` property access are followed; a local that
  only shares the name is not the table. Test code (throwaway databases, never
  the serving backend) and the migration runner are exempt.
- A generic writer finds a table's producer with `changeProducerFor(table)`:
  retention's `sweepExpired` deletes through it when one exists (the deleted ids
  come from RETURNING), and takes its plain `DELETE` otherwise.
- Tests mount producers without a booted graph with the testing barrel's
  `mountProducersForTest(producers, { route?, mode? })` and drive the window with
  `flushNow(producer)`.

## The LISTEN connection

`listener.ts` opens one dedicated client with the connection plugin's
`createDbClient({ name: "change-feed" })`, on the direct socket. It LISTENs on
two channels — `live_state` (every table change) and `live_state_end` (each
transaction's end marker, below) — in ONE statement, `LISTEN live_state; LISTEN
live_state_end`: both take effect at its commit, so no transaction is seen on one
channel and not the other. Its connect and that statement each give up after 60 s
with no reply, and that failure takes the same reconnect path as any other
connect failure. The client it happened on is abandoned, never closed.

Its `error` / `end` handlers act only while that client is the current one. An
attempt that failed, or a client already retired, can emit later — a late `end`,
an `error` on an abandoned socket — and must not tear down the healthy client
that replaced it or schedule a second reconnect.

An established LISTEN with no call pending has nothing waiting for a reply, so a
silent socket is still not detected; that needs a heartbeat.

**One transaction's NOTIFYs route as one burst, after its end marker**
(`burst.ts`, `txn-end.ts`). A transaction writing N tables sends N NOTIFYs together
at commit, but the socket may hand them over in several reads, and the runtime
drains on the next microtask — so routing each one as it arrived could drain
between two of them and ship that transaction's ack (`ackTx`) before its second
change reached the tuple: an optimistic client confirms an op whose row it has not
been sent yet, and flashes the old value.

- **The marker.** `live_state_txn_end`, a `CONSTRAINT TRIGGER … AFTER INSERT ON
  live_state_changelog DEFERRABLE INITIALLY DEFERRED FOR EACH ROW` (both notify
  functions insert one changelog row per statement). Deferred triggers fire at
  commit, after every statement, so its NOTIFY is the transaction's last; all
  channels share one queue, so the order holds across channels. It emits once
  per transaction (a transaction-local `live.txn_end` setting holds the xid):
  `pg_notify('live_state_end', {x, n})`, `n` the xid's changelog row count
  (`live_state_changelog_xid_idx`). It is part of the shared layer: installed in
  the prelude, fingerprinted with it, and re-verified by `planRebuild` (the
  function exists; the trigger is on the changelog, calls it, is deferred and
  enabled). The trigger is created only when the catalog says it is missing or
  different — `CREATE TRIGGER` locks the changelog every writer INSERTs into.
  `planRebuild`'s stale-trigger sweep skips it (the changelog is denylisted).
- **The router.** A change carrying an xid is held under it; on the xid's end its
  changes move, in arrival order, to the ready queue, routed from one macrotask. A
  change with no xid routes on the next macrotask. The guarantee is exact: the
  whole transaction lands in the same pendings, however the socket split it.
- **Nothing is ever dropped.** Each broken assumption is reported (logged with
  its specifics, filed once per kind as `ChangeFeedTxnEndError`), then routed:
  `change-after-end` (a change after its xid's end — a `SET CONSTRAINTS ALL
  IMMEDIATE` would do it); `over-count` (more changes than `n`; Postgres folds
  identical payloads, so `n` is an upper bound); `interleaved` (a new xid's
  change while an older xid is open — one transaction's NOTIFYs are contiguous —
  which releases the older); `txn-end-missing` (nothing received for an open xid
  for 2 s — one one-shot timer, re-armed for the remainder when a change arrived
  meanwhile, so a long burst still streaming in is never cut at its first
  change's deadline — then released; the check waits one more macrotask, so after
  an event-loop stall the end already waiting on the socket still wins). An end
  payload that does not parse strictly is logged and skipped; its xid is released
  by the deadline. `stop()` and a retired socket release an open xid unreported
  and hold nothing until a socket LISTENs again (a cut-off transaction's end
  never reaches the next socket; the reconnect sweep covers the gap).
- **Boot assertion** (`installFeed`): no deferred or deferrable non-internal
  trigger other than the marker sits on a triggered table or on the changelog —
  it would fire at commit and could NOTIFY after the marker. Internal triggers (a
  deferrable foreign key or unique check) write nothing.
- The L2 catch-up replays the changelog in one synchronous loop through
  `routeChange`, not through the router, so it needs no marker.

Every routed change, including a reconnect sweep's, records a `route` profiler span
labelled by the table (`route-span.ts`). Its duration is only the synchronous routing
work. Two numbers ride along as measures: `ids` (how many changed ids) and
`sinceChangeMs` (the trigger firing → routed). `sinceChangeMs` is a measure rather
than the duration because it also counts how long the writing transaction stayed
open.

## One entry, one router

`routeChange` (`internal/route-change.ts`) is the single entry every change takes —
the LISTEN consumer, the L2 catch-up replay and the reconnect `fullSweep` (all
`FeedChange`s, `source: "feed"`), and the change producers (`ProducerChange`,
`source: "producer"`: ids only, no layout, no transaction to ack). It hands each
change, with its source, to the runtime's `routeTableChange`, which serves every
DB-backed resource through its declared reads:

- a compiler's `routes` (per-table host-id maps and a per-tuple read-set): a
  side-table write costs O(changed) and reaches only the tuples whose query
  reads that table. Every `serveCollection` resource (window, `:rows`,
  `:groups`) is routed. A routed table's trigger carries its key layout and its
  `unchanged` set (above), which `routeChange` hands on as `keys` / `unchanged`;
  every other table's are `null` (unknown).
- a non-keyed value's `reach` plan (a `serveValue` db value's `reads`, or a
  notified external's): `full` routes, each recomputing the reached tuples in
  FULL, and relation reads — a view or rollup read whole, indexed under its
  **relation bases** (`internal/relation-bases.ts`, C30): a view's tables
  transitively, a rollup replaced by its sources. A reader of `tasks_v` is
  reached by a write to `conversations`. The graph is read in
  `onReadyBlocking` and installed with server-core's `setRelationBases` (D34),
  which indexes every plan's relation reads; D35 (in `installFeed`) blocks
  boot when a view or rollup reaches a base with no change source.

A DB-backed resource with neither is refused at boot (D6, above).

`route-change.test.ts` drives the real `routeChange` into the real server-core
runtime (a routed and a reach entry on one table: each reached exactly once —
the routed one scoped, the reach one as one FULL reload — with the
transaction's ack), and then the whole feed on a throwaway
database — `rebuildTriggers` → a real `UPDATE` → the listener → `routeChange` → a
delta on the wire. Without it, a `routeChange` that stopped calling the router would
freeze every collection at its hydrated value with every other suite green.

See `research/2026-09-29-global-scoped-change-routing.md`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: L4 DB change-feed: STATEMENT-level Postgres triggers that pg_notify on every commit, plus a LISTEN consumer routing each change through the live-state recompute cascade — making missed invalidations structurally impossible and out-of-process writes visible. A table written only by this backend at high rate may instead declare an in-process change producer (defineChangeProducer): no trigger, its `mutate` owns the write and routes the returned ids, coalesced at the source and volatile.
- Server:
  - Contributes: `fork-data-exclusion` "live_state_changelog"
  - Uses:
    - `database.db`
    - `database.loadKnownRelations`
    - `database/admin.connectionString`
    - `database/admin.ExcludeFromFork`
    - `database/connection.BOOT_DDL_QUERY_DEADLINE_MS`
    - `database/connection.createDbClient`
    - `database/connection.DbClient`
    - `database/connection.withQueryDeadline`
    - `database/derived-tables.feedExemptTables`
    - `database/derived-tables.rollupSources`
    - `primitives/log-channels.defineLogSink`
  - DB schema: `plugins/database/plugins/change-feed/server/internal/produced-tables.ts`
  - Exports (types):
    - `ChangeProducer`
    - `ChangeProducerContribution`
    - `ChangeProducerOptions`
    - `ChangeProducerSpec`
    - `DbChange`
    - `FeedChange`
    - `ProducerBuilder`
    - `ProducerChange`
    - `ProducerExecutor`
    - `RoutedChange`
    - `WriteLatency`
  - Exports (values):
    - `changeProducerFor`
    - `defineChangeProducer`
    - `ExcludeFromChangeFeed`
    - `getCoveredTables`
    - `parseLiveStatePayload`
    - `producedTableNames`
    - `PRODUCER_IDS_CAP`
    - `readLayout`
    - `rebuildTriggers`
    - `relationBases`
    - `routeChange`
- Cross-plugin:
  - Imported by:
    - `apps/chord/song-index`
    - `apps/chord/video-availability`
    - `apps/deploy/analytics/collect`
    - `database/live-state-snapshot`
    - `debug/latency-ledger`
    - `debug/slow-ops`
    - `debug/trace/engine`
    - `infra/retention`
    - `reports/engine`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `server/internal/producer.ts`, `server/internal/triggers.ts` (debt)
- Test helpers:
  - Server: `@plugins/database/plugins/change-feed/server/testing`
    - `assertRouteLayoutsInstalled` — A3: throw (block boot) unless every routed table's installed triggers emit what its routes read.
    - `assertRouteTablesCovered` — Throw loudly (blocking boot) if any resource depends on a table with no change source: no trigger the change-feed installed, and no change producer.
    - `buildViewDeps` — Each public view → the relations it directly reads (sorted).
    - `createChangeFeedListener`
    - `createChangeRouter` — The routing above, into ANY runtime's router — `routeChange` is it bound to server-core's process-global runtime.
    - `createRelationBases` — The memoized relation → bases function over `graph`.
    - `ensureChangelogTable`
    - `findCarriedProducedRoutes` — A3p: the produced tables whose routes need a carried column.
    - `flushNow` — Flush `producer`'s coalescing buffer now (a test drives the window by hand).
    - `installedLayouts` — What each table's installed triggers emit.
    - `installRelationGraph` — Install the boot graph (change-feed's `onReadyBlocking`, D34): here, and in server-core's runtime (`setRelationBases`, which indexes every reach plan's relation reads through it).
    - `mountProducersForTest` — Mount `producers` without a booted plugin graph: each is live (A12 passes), runs as boot mode `mode` (default `"serve"`; pass `"exec"` to see A13), and routes through `route` (default the real `routeChange`).
    - `readInstalledTriggers` — Every installed `live_state_*` trigger on the given tables.
    - `rebuildTriggers`

<!-- AUTOGENERATED:END -->

## Invariant harness (DB-backed)

`server/internal/listener.test.ts` pins the LISTEN consumer against a **real
Postgres** — the DB-backed half the resource-runtime fake-injection seam can't
reach. It covers: NOTIFY delivery (`LISTEN live_state` → `parseLiveStatePayload`
→ `route`), first-connect-does-NOT-fullSweep vs reconnect-DOES-fullSweep (driven
by a real socket drop via `pg_terminate_backend`), malformed-payload skip,
`stop()` teardown, and — with the real triggers installed — the end marker: one
2000-statement transaction routed as ONE burst after its `live_state_end`, an
xid-less NOTIFY still routed, a malformed end released by the deadline. Apart
from that last block, the listener is exercised at its true contract boundary —
`pg_notify('live_state', <payload>)`, the exact wire the STATEMENT trigger emits
— so it needs no triggers or tables of its own (trigger→NOTIFY→changelog is the
trigger layer's concern, pinned by `triggers.test.ts` and `routed-trigger.test.ts`).
`burst.test.ts` drives every router case by hand (injected macrotask and timers).

To make it testable, `listener.ts` is an injectable factory
(`createChangeFeedListener({ connectionString, route, coveredTables, …timers })`)
with all state per-instance; the production singleton is re-presented as the same
`startListener`/`stopListener` exports. The shared `db-test-fixture` primitive
(`createTestDb({ prefix: "cf_test" })`) provisions an isolated throwaway database
on the running cluster via admin's public barrel
(`ensureDatabase`/`openShortLivedClient`/`dropDatabase`) and drops it after.

**Running:** these suites need a running cluster (started by `./singularity
build`) — run with a plain `bun test plugins/database/plugins/change-feed`.
Nothing has to be set in the environment: the root `bunfig.toml` `[test]` preload
(`test/bun-preload.ts`) declares the current checkout as the test process's
runtime namespace. The
fixture throws loudly (never silently skips) if the cluster is unreachable. See
`research/2026-07-03-database-live-state-db-backed-invariant-harness.md`.
