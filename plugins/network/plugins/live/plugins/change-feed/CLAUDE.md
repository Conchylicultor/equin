# change-feed

## Portable: every host with a database runs it

The server half is portable: the desktop's backend runs it on the
Postgres cluster, a browser host's worker (the demo) on PGlite — same plpgsql,
same fingerprints, same boot invariants, same consumer (burst router, end-marker
ordering, `routeChange`, reconnect policy). The one thing that differs per host
— opening a LISTEN session — is the host's `DatabaseDriver.listen`
(`database/server`): the desktop's opens a dedicated connection on the direct
socket (`database/connection`'s `openListenSession`), PGlite LISTENs on its one
in-process connection (`database/pglite`). No `if (browser)` anywhere: which
LISTEN runs is decided by which driver the host booted. The listener starts in
`onReady`, which every serving host runs (`serve`, and a browser host after its
seed) and an `exec` child does not. The trigger rebuild runs under the driver's
`bootDdl` (the desktop's widened deadline; PGlite adds none). The changelog's
fork exclusion is the desktop's concern and lives in `machine/`.

`live_state_changelog` is read and pruned by `live-state-snapshot` (L2), which
is portable too and boots wherever this plugin does: the browser host's
changelog is bounded by the same prune policy as the desktop's, not by the
tab's life. There is no second trigger body for a host without a catch-up
consumer.

"Boots wherever this plugin does" is DERIVED, not listed. L2 imports this
plugin (`routeChange`, `relationBases`), so this plugin cannot import it back;
instead it declares what bounds its changelog as a **companion kind** —
`ChangelogRetention` (`defineServerContribution<{ reason }>(
"change-feed-changelog-retention", { companions: true })`, exported from the
server barrel) — and L2's server barrel contributes `ChangelogRetention({
companion: true, reason })`. The closure engine turns that into a hard
`network.live.change-feed → network.live.live-state-snapshot` edge, so every
composition bundling the feed bundles L2 (the agent-manager compositions and
the demo's browser-host graph did not before: nothing imported L2). The kind
also means something at runtime: `onReady` — which only serving hosts run —
asserts at least one `ChangelogRetention` contribution
(`assertChangelogRetained`), after starting the listener, so a graph assembled
outside the closure engine reports an unbounded changelog instead of growing
one silently. `exec` children and partial-graph test boots never reach it.
The plugin is not `loadBearing`, so that throw is logged by the boot sequence
rather than killing the serving backend.

A serving host whose graph serves DB-backed reads but boots no change feed fails
at boot (server-core's `assertDbReadsHaveChangeFeed`, keyed on the relation
bases this plugin sets in `onReadyBlocking`). The G0 spike that pins the
Postgres behaviours the feed leans on, on PGlite, is
`database/plugins/pglite/server/internal/notifications.test.ts`.

## The trigger install: one `db-triggers` set, one transaction per table

`rebuildTriggers` (`internal/triggers.ts`) installs the feed on every
non-excluded public table. The previous backend is still serving reads and
writes of those tables during a hot swap. Its blocking hook starts after the
database plugin's: blocking hooks are sequenced by `dependsOn`, so the schema
layer (migrations → the one `db-triggers` call → rollup reconcile → view
rebuild) has already committed.

- **Prelude, its own transaction, every boot:**
  - `ensureChangelogTable`;
  - `CREATE OR REPLACE` of the end marker's function;
  - its deferred trigger, created only when the catalog says it is missing or
    different.

  Nothing in the prelude takes a user-table lock. It touches the changelog
  only for a piece the catalog says is missing: every trigger INSERTs into
  the changelog, and `ALTER … ADD COLUMN IF NOT EXISTS` or `CREATE INDEX IF
  NOT EXISTS` lock it even with nothing to do.
- **The `change-feed` trigger set**: both notify functions plus three
  `CREATE OR REPLACE TRIGGER`s per table (`compileTableTriggerDdl`), handed to
  `installDbTriggers(db, [set], { commit: "per-table" })`. The installer's
  protocol (`database/db-triggers` CLAUDE.md) gives the feed:
  - **Per-object stamps.** A steady-state boot re-runs nothing and takes ZERO
    table locks. A new table, a dropped exclusion or a route's changed layout
    re-runs exactly the tables whose triggers change. A trigger dropped,
    disabled or replaced out of band is re-run.
  - **Replace in place.** A changed layout (REFERENCING clause included) is
    SHARE ROW EXCLUSIVE, never a DROP's ACCESS EXCLUSIVE, so the old backend's
    readers never wait on it.
  - **Ownership by function.** A `live_state_*` trigger left on a table now
    excluded (opt-out, rollup, produced) calls a feed function and is dropped.
  - **Asserted after.** Boot never proceeds on a half-installed feed.
- **One transaction per table.** The old design DROP+CREATEd every table in
  ONE transaction: it held exclusive locks on an alphabetical prefix while
  asking for more, and the old backend's reads closed a cycle
  (build-1784288281433-w62dep, `attempts` ⇄ `conversations`, 40P01). A
  transaction that only ever locks one relation cannot be a node in a wait
  cycle, so the deadlock is impossible, not retried. This is also why the feed
  is NOT in the schema layer's one-transaction call, beside the set being
  derived from the booted resource registry, which the layer's dry run cannot
  build. The plugin contributes `DbTriggerClaim("change-feed")` so the
  layer's sweep spares it. Decision:
  `research/2026-11-05-global-change-feed-triggers-vs-db-triggers.md`.
- **No object is ever half-built.** The notify functions commit first, so old
  and new triggers both call the current function. A table's three triggers
  are replaced together.
- **Adopting the former installer** (compatibility). A table whose row in the
  former `live_state_trigger_state` matches what that installer stamped for
  today's layout is restamped (COMMENT only), not re-created. The state table
  is then dropped, so an older build on a fork rebuilds instead of trusting
  stale rows. Delete once no supported database predates the switch.

The tables it must skip beyond its own plumbing — derived-table rollups,
`ExcludeFromChangeFeed` opt-outs, produced tables — are contribution sets, so
`rebuildTriggers(db, exclusions, layouts)` takes them as an argument
(`TriggerExclusions`). The boot hook reads them; a suite on a throwaway
database passes its own.

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
- The function is `live_state_notify_routed(pk, carry_json, gate_json)`, in the
  `change-feed` set beside `live_state_notify()`. **Every other table's trigger is
  byte-identical to the PK-only feed's** — DDL (`compileTableTriggerDdl` with no
  layout) and payload (`{t, op, ids, x, at}`), pinned by `routed-trigger.test.ts`.
  A routed table's layout rides its trigger arguments, so a changed layout changes
  that table's DDL and stamp: that table alone is re-run (replaced in place).
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
`./equin check`, because neither can reach a live DB nor the server-only
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
  A13: `mutate` outside a serving host (`bootMode` neither `"serve"` nor
  `"browser"`) throws — an exec child files through the outbox. A2′: one producer per table (module eval);
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

`listener.ts` opens one session through the host's `DatabaseDriver.listen` on
two channels — `live_state` (every table change) and `live_state_end` (each
transaction's end marker, below) — in ONE statement, `LISTEN live_state; LISTEN
live_state_end`: both take effect at its commit, so no transaction is seen on one
channel and not the other. The policy is the listener's (reconnect with capped
backoff, the liveness watchdog, first-connect vs `fullSweep`,
`burst.close()`/`reopen()`); the session is the driver's.

On the desktop the session is a dedicated client the connection plugin builds
(`openListenSession`, `createDbClient({ name: "change-feed" })`) on the direct
socket. Its connect and LISTEN statement each give up after 60 s with no reply,
and that failure takes the same reconnect path as any other open failure; the
client it happened on is abandoned, never closed. Its `error` / `end` reach the
listener (`lost`) only while that session is established and current — a failed
attempt's late `end`, or an `error` on an abandoned socket, must not tear down
the healthy session that replaced it or schedule a second reconnect. On PGlite
the session is never lost.

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
  (`live_state_changelog_xid_idx`). It is NOT in the `change-feed` set (a
  CONSTRAINT trigger cannot be replaced in place, and it calls no feed
  function, so the set never owns it): the prelude `CREATE OR REPLACE`s its
  function every boot and creates the trigger only when the catalog says it is
  missing or different (on the changelog, calling it, deferred, enabled) —
  `CREATE TRIGGER` locks the changelog every writer INSERTs into.
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

## The feed cut (`feedCut`, `internal/cut.ts`)

`feedCut()` → `{ cutXid }`: once it resolves, every change of every
transaction with an xid below `cutXid` has gone through this process's router.
It captures the snapshot watermark, then NOTIFYs a token on a third channel
the listener LISTENs in the same statement (`live_state_barrier`); on that
token the listener drains the burst router synchronously (`BurstRouter.drain`
— everything held committed before the barrier) and answers. Postgres delivers
one session's notifications in commit order, so every earlier transaction's
changes and end marker arrived first. It is refused with no session, on a
session lost or a listener stopped while waiting, and past 1.5 s. The epoch
handoff's old half (live-state-snapshot) is its consumer; `feedListening()`
(resolves once the first LISTEN session is up) gates its successor's replay.
`live_state_handoff` is denylisted like the other plumbing tables. The barrier
wait and the NOTIFY are awaited together, so a deadline that passes while the
NOTIFY is still pending rejects the cut, never the process. Pinned by
`barrier.test.ts` and `cut.test.ts`.

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

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: L4 DB change-feed: STATEMENT-level Postgres triggers that pg_notify on every commit, plus a LISTEN consumer routing each change through the live-state recompute cascade — making missed invalidations structurally impossible and out-of-process writes visible. A table written only by this backend at high rate may instead declare an in-process change producer (defineChangeProducer): no trigger, its `mutate` owns the write and routes the returned ids, coalesced at the source and volatile.
- Server:
  - Contributes:
    - `db-trigger-claim` "change-feed"
    - `fork-data-exclusion` "live_state_changelog"
  - Uses:
    - `database.DatabaseDriver`
    - `database.DatabaseDriverImpl`
    - `database.db`
    - `database.ListenSession`
    - `database.loadKnownRelations`
    - `database.snapshotWatermark`
    - `database/db-triggers.DbTriggerClaim`
    - `database/db-triggers.DbTriggerDdl`
    - `database/db-triggers.DbTriggerSet`
    - `database/db-triggers.defineDbTriggers`
    - `database/db-triggers.installDbTriggers`
    - `database/derived-tables.feedExemptTables`
    - `database/derived-tables.rollupSources`
    - `primitives/log-channels.defineLogSink`
  - DB schema: `plugins/network/plugins/live/plugins/change-feed/server/internal/produced-tables.ts`
  - Exports (types):
    - `ChangeProducer`
    - `ChangeProducerContribution`
    - `ChangeProducerOptions`
    - `ChangeProducerSpec`
    - `DbChange`
    - `FeedChange`
    - `FeedCut`
    - `ProducerBuilder`
    - `ProducerChange`
    - `ProducerExecutor`
    - `RoutedChange`
    - `WriteLatency`
  - Exports (values):
    - `ChangelogRetention`
    - `changeProducerFor`
    - `defineChangeProducer`
    - `ExcludeFromChangeFeed`
    - `feedCut`
    - `feedListening`
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
    - `apps/deploy/site-messages/intake`
    - `conversations/runtime-sdk`
    - `conversations/usage`
    - `debug/latency-ledger`
    - `debug/slow-ops`
    - `debug/trace/engine`
    - `infra/jobs/in-process`
    - `infra/retention`
    - `network/live/live-state-snapshot`
    - `reports/engine`
- Test helpers:
  - Server: `@plugins/network/plugins/live/plugins/change-feed/server/testing`
    - `assertRouteLayoutsInstalled` — A3: throw (block boot) unless every routed table's installed triggers emit what its routes read.
    - `assertRouteTablesCovered` — Throw loudly (blocking boot) if any resource depends on a table with no change source: no trigger the change-feed installed, and no change producer.
    - `assertUnfedTablesOptedOut` — A reach plan's `unfed` tables are read outside the change feed BY DECLARATION, so each must be one the feed was told to skip (`ExcludeFromChangeFeed`).
    - `buildViewDeps` — Each public view → the relations it directly reads (sorted).
    - `createChangeFeedListener` — An isolated LISTEN consumer on a suite's own database: the real listener over the desktop driver's session (`openListenSession`, the one `DatabaseDriver.listen` opens), pointed at the suite's connection string rather than the worktree's.
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
    - Types: `TestChangeFeedListenerOptions`

<!-- AUTOGENERATED:END -->

## Invariant harness (DB-backed)

`server/internal/listener.test.ts` pins the LISTEN consumer against a **real
Postgres** — the DB-backed half the resource-runtime fake-injection seam can't
reach. It covers: NOTIFY delivery (`LISTEN live_state` → `parseLiveStatePayload`
→ `route`), first-connect-does-NOT-fullSweep vs reconnect-DOES-fullSweep (driven
by a real socket drop via `pg_terminate_backend`), an unparseable change payload
(never dropped: logged, reported, and every covered table swept FULL, as on a
reconnect — a routed cut then cannot advance a persisted alias past it),
`stop()` teardown, and — with the real triggers installed — the end marker: one
2000-statement transaction routed as ONE burst after its `live_state_end`, an
xid-less NOTIFY still routed, a malformed end released by the deadline. Apart
from that last block, the listener is exercised at its true contract boundary —
`pg_notify('live_state', <payload>)`, the exact wire the STATEMENT trigger emits
— so it needs no triggers or tables of its own (trigger→NOTIFY→changelog is the
trigger layer's concern, pinned by `triggers.test.ts` and `routed-trigger.test.ts`).
`burst.test.ts` drives every router case by hand (injected macrotask and timers).

To make it testable, `listener.ts` is an injectable factory
(`createChangeFeedListener({ listen, route, coveredTables, …timers })`) with all
state per-instance; the production singleton (listening through
`DatabaseDriver.get().listen`) is re-presented as the same
`startListener`/`stopListener` exports. `listener.test.ts` injects the desktop
driver's session (`openListenSession`) on its throwaway database; the testing
barrel's `createChangeFeedListener({ connectionString, … })` does the same for
other plugins' suites. The shared `db-test-fixture` primitive
(`createTestDb({ prefix: "cf_test" })`) provisions an isolated throwaway database
on the running cluster via admin's public barrel
(`ensureDatabase`/`openShortLivedClient`/`dropDatabase`) and drops it after.

**Running:** these suites need a running cluster (started by `./equin
build`) — run with a plain `bun test plugins/network/plugins/live/plugins/change-feed`.
Nothing has to be set in the environment: the root `bunfig.toml` `[test]` preload
(`test/bun-preload.ts`) declares the current checkout as the test process's
runtime namespace. The
fixture throws loudly (never silently skips) if the cluster is unreachable. See
`research/2026-07-03-database-live-state-db-backed-invariant-harness.md`.
