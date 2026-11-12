# Table mirror: pull a remote database's tables into local Postgres, with Sessions, Analytics, site-messages and site-reports on it

Task: att-1794496263. Plan only. Nothing here is implemented yet.

**Revision 2026-11-12 (user review).** A replica that cannot trust its deltas (fallen behind the
log horizon, a reinstalled box, a schema change) no longer re-copies into a fresh schema and
swaps it in. It **reconciles**: the box sends each row's key and a hash, the mirror deletes the
keys the box no longer has and fetches only the rows that differ. A full copy is left only for a
replica's first sync. The user also confirmed that site-reports keeps only the reduced form
locally (no raw rows).

## Context

Today, every time the Deploy app shows a deployed site's data, this computer SSHes into the
site's server and asks the server to compute the answer. That covers analytics (the Sessions
tab, the Analytics tab and the Overview's Traffic / Top cards), the contact-form inbox, and
visitor error reports.

- `hostOnlyQueryOverSsh` (`apps/deploy/host-query`) curls a host-only route on the box.
- The box runs collect's SQL and sends back finished JSON:
  - one SSH session for each page of 50 visits (`analytics/sessions/server/internal/served.ts`);
  - one more for the per-shape counts;
  - one for each report (`analytics/dashboard/server/internal/served.ts`).
- Nothing is kept here. All of these values are `source: "external"`, `changes: { snapshot }`.

What this costs:

- **Sessions cannot filter or search the server's data.** Its DataView only sees the rows
  already loaded. The `filterable` flags on its fields filter just those rows. The tab has a
  hand-rolled range / audience / shape strip held in `useState`.
- **The inbox shows only the newest 200 messages** (`site-messages/inbox`).
- **site-reports/import can miss rows.** It reads the newest 100 fingerprints each hour and keeps
  a watermark on `lastSeenAt`. A row that falls off that 100-row page is not imported until it
  recurs.
- **Every read waits on SSH and on the box's CPU.** Nothing can be inspected while the box is
  unreachable.

**Outcome.** One generic, reusable **table mirror** primitive:

- The source sends only deltas: current rows plus tombstones.
- The mirror applies them into local Postgres tables with the **same DDL**, so the owning
  plugin's own SQL runs unchanged against the copy.
- Deletions on the source, including cascades and the 90-day privacy retention, reach the
  mirror through the sync itself. The mirror has no retention rule of its own.

Then four consumers move onto it.

## Decision summary (the direction, validated and where challenged)

| Point | Verdict |
|---|---|
| Pull-based, over the existing host-only SSH channel, with no inbound endpoint | **Kept.** Pulls happen on tab open, on Refresh, and from an hourly job on main. There is no timer. |
| Postgres logical replication | **Rejected**, see below. |
| Triggers into one change log with one entry per primary key | **Kept, sharpened.** Use statement-level triggers with transition tables (set-based, which suits the rollup's bulk upserts and the retention's bulk deletes). Log rows of every kind, upserts included, are pruned below a horizon, so the log is bounded by *recent* changes, not by table size. |
| Cursor is an xid8 snapshot watermark, not a sequence | **Kept.** It is the same rule as `snapshotWatermark` / `live_state_changelog`. The cursor is `{ floor, after }` so that one pull can be paged. |
| One schema per deployment | **Challenged → one schema per (deployment, mirrored set).** Each set has its own cursor and its own reconciliation, so analytics can reconcile without touching the inbox, and a deleted set is one `DROP SCHEMA`. |
| Same DDL, so collect's queries run unchanged | **Kept.** The mirror's tables are `CREATE TABLE … (LIKE public.<t>)` from the local install's own tables. Readers run in a transaction with `SET LOCAL search_path TO <mirror schema>, pg_catalog`. |
| Schema hash, with full re-copy as the fallback | **Kept the hash; replaced the full re-copy with key+hash reconciliation.** A per-table column fingerprint on both sides. A mismatch (or a mirror fallen behind the horizon, or a reinstalled box) triggers reconciliation: the box sends each row's key and a hash, and only rows that differ travel. A full copy happens only on a replica's first sync. A named refusal remains for a box *older* than this computer in a NOT NULL column. |
| Never mirror `analytics_salts` / `analytics_visitor_links` | **Kept, and enforced.** collect declares them `neverMirrored`. `defineMirrorSet` throws at boot if one is listed. |
| site-reports onto the mirror | **Challenged → it uses the change stream, but not a raw mirror table.** The reduce step sits between the stream and Reports (a "sink"). Raw `site_reports` rows never land in a local table. |

### Why not Postgres logical replication

- **WAL retention on a small box.** A replication slot pins WAL until the subscriber confirms it.
  This laptop sleeps for days, so the box's disk fills with WAL for a reader that is away.
  (`max_slot_wal_keep_size` only turns that into "slot invalidated, re-copy everything". Our
  log horizon gives the same bound with a cheap reconciliation instead, and no disk risk.)
- **It needs an inbound or persistent connection.** That is a long-lived tunnel to the box's
  Postgres, where today we have one curl per SSH session through the gateway. It also needs the
  box's Postgres to accept replication connections and run `wal_level=logical`.
- **It is all-or-nothing on schema.** Native subscriptions need the subscriber's tables to match,
  and break on the first DDL the other side has not applied. Laptop and box run different
  releases by design.
- **Precedent.** We removed Zero (`research/2026-09-22-database-remove-zero-sync-engine.md`), whose
  core was a logical-replication slot per database, for the same operational weight.

A row-level change log behind the HTTP route the box already exposes keeps every one of these
properties under our control. Its costs are one extra upsert per write statement on mirrored
tables, and keeping the log bounded.

## Plugin layout and API

The generic primitive knows nothing about SSH, deployments or analytics:

```
plugins/database/plugins/table-mirror/            umbrella
  core/        wire protocol: MirrorCursor, MirrorPage, MirrorCopyPage, TableFingerprint,
               SourceIdentity, MirrorRefusal ("reconcile-required" | "unknown-set" | …), zod schemas
  plugins/source/   server — runs wherever the data lives (a deployed box; this instance too, for demos)
  plugins/replica/  server (+ web for the status line) — runs where the copy lives
```

The deployment glue lives in the deploy app:

```
plugins/apps/plugins/deploy/plugins/site-mirror/
  plugins/box/   server, ships on the box: the two host-only routes over source's readers
  plugins/pull/  server + web, local only: one replica per (deployment, set), the transport
                 over hostOnlyQueryOverSsh, the hourly job, Sync-now endpoint, freshness UI
```

`table-mirror` sits under `database/` because it is a database primitive: triggers, a change
log, schemas, transactional apply. `site-mirror` is split in two for the same reason
`host-only` and `host-query` are: the box half must never pull in SSH.

### Source half — `database/table-mirror/source`

```ts
// collect/server
export const analyticsMirror = defineMirrorSet({
  id: "analytics",
  tables: [analyticsVisits, analyticsHits, analyticsDaily, analyticsVisitMembers],
});
// contributions: [MirrorSet(analyticsMirror), NeverMirrored(analyticsSalts, analyticsVisitorLinks)]
```

- **`defineMirrorSet({ id, tables, omit? })`.**
  - Tables are drizzle tables, and the PK columns are read from `getTableConfig`.
  - `omit` lists columns that never leave the source, such as site-messages' `ip_hash`. Each one
    must be nullable or have a default; this is asserted.
  - Listing a table marked `NeverMirrored` throws at module eval. A test also pins collect's two
    privacy tables.
- **Log.** `table_mirror_log(set_id, tbl, pk jsonb, xid xid8, deleted bool, PRIMARY KEY (tbl, pk))`,
  with an index on `(set_id, xid, tbl, pk)`. It holds one row per primary key ever changed, until
  pruned.
- **Triggers.**
  - One `defineDbTriggers` set, generated from every contributed `MirrorSet` (the change-feed
    pattern: built from the registry after boot, `installDbTriggers(…, { commit: "per-table" })`,
    claimed with `DbTriggerClaim`).
  - Each table gets statement-level `AFTER INSERT/UPDATE/DELETE … REFERENCING NEW/OLD TABLE`:
    ```sql
    INSERT INTO table_mirror_log (set_id, tbl, pk, xid, deleted)
    SELECT '<set>', '<tbl>', jsonb_build_object('id', id), pg_current_xact_id(), <TG_OP='DELETE'>
    FROM new_rows   -- old_rows for DELETE
    ON CONFLICT (tbl, pk) DO UPDATE SET xid = excluded.xid, deleted = excluded.deleted;
    ```
    An UPDATE that changes a PK logs a tombstone for the old key and an upsert for the new one.
  - **Cascaded deletes are covered.** The FK `ON DELETE CASCADE` on `analytics_hits` runs a
    DELETE on the child, which fires the child's statement trigger with its own transition table.
    This is pinned by a test, because it is the mechanism behind the user's hard requirement.
  - A `TRUNCATE` trigger bumps the source's `epoch`, which forces every replica to reconcile.
- **Identity.** `table_mirror_source(id bool PK, source_id uuid, epoch int)`. The identity sent
  with every page is `{ sourceId, systemIdentifier (pg_control_system()), epoch }`.
  - A box re-installed or restored into a new cluster changes it, and so does a TRUNCATE.
  - A replica holding another identity reconciles.
  - xid8 never wraps, so a cursor is comparable for the life of the cluster.
- **Readers** (pure functions over a db; the routes are in `site-mirror/box`):
  - **`readMirrorChanges(db, { setId, cursor, maxRows, maxBytes })`** runs one read-only
    `REPEATABLE READ` transaction:
    1. `xmin := pg_snapshot_xmin(pg_current_snapshot())`, taken first in the same snapshot.
    2. If `cursor.floor < horizon`, answer `{ kind: "reconcile-required" }`. Never a partial page.
    3. Select log rows with `xid >= floor AND (xid, tbl, pk) > after`, ordered by
       `(xid, tbl, pk)`. Each row is `LEFT JOIN`ed to its table by PK (SQL generated per table)
       and returns `to_jsonb(t) - omit` and its row hash `h` for an upsert, or the PK only for a
       tombstone.
    4. Stop at `maxRows`, or when a running `sum(octet_length(row))` passes `maxBytes`.
    5. Answer `{ identity, fingerprints, xmin, now, rows, done }`. An upsert log row with no table
       row cannot happen (the trigger flips the log in the same transaction), so it throws.
  - **`readMirrorCopy(db, { setId, table, afterPk, maxRows, maxBytes })`** is a keyset page of
    the table itself (rows with their `h`). It is used **only for a replica's first sync**, when
    there is nothing local to compare against. It runs in the same kind of transaction and
    returns the same `xmin`.
  - **`readMirrorKeys(db, { setId, table, columns, afterPk, maxKeys })`** is a keyset page of
    `(pk, h)` only, about 40 bytes per row. It is used for reconciliation (below). `columns` is
    the replica's column list, so the hash covers exactly the columns both sides have.
  - **`readMirrorRows(db, { setId, table, pks, maxBytes })`** returns the current rows (with
    `h`) for a bounded list of keys. It fetches what reconciliation found different.
  - **Row hash `h`.** `md5` of the row's `jsonb` restricted to the hashed columns, as text. The
    same expression is computed on both sides, in Postgres. jsonb's text form is canonical (keys
    sorted). Both sides set `SET LOCAL TimeZone = 'UTC'` first, so a `timestamptz` renders the
    same.
  - **Key order.** Every keyset page orders by PK with `COLLATE "C"` on text columns, on both
    sides, so the two walks visit keys in the same order whatever the databases' collations.
  - **`fingerprints`** is a per table sha256 over `(column, type, not null)` read from
    `information_schema`, minus omitted columns.
- **Tombstone horizon.**
  - `table_mirror_marks(at timestamptz, xmin xid8)`: the prune job records one mark per run.
  - The prune job (daily, `perWorktree: true`, because a deployed box is never main; the same
    reason the rollup gives) deletes every log row with `xid < M`. M is the newest mark at least
    `TOMBSTONE_RETENTION_DAYS` old. The job then sets `horizon = M`.
  - Upserts below the horizon go too. A replica whose floor is at or above M already has them,
    and one below M reconciles against the tables. **So the log holds only the last
    `TOMBSTONE_RETENTION_DAYS` of changes**: roughly 30 days of visits and hits for collect, not
    its forever tables.
  - **Proposed: 30 days.** That is how long the computer may be off before it must reconcile
    instead of reading deltas. Reconciling sends keys and hashes for every row, plus the rows that
    differ, so it is cheap. The retention could be shorter if the box's disk ever needs it.

### Cursor correctness (why `{ floor, after }`)

- **Within one pull**, pages advance by `after = (xid, tbl, pk)` of the last row taken, with the
  `floor` fixed.
- **When the last page is `done`**, the replica's next floor becomes the `xmin` of the pull's
  **first** page. Every change committed after that snapshot was made by a transaction in progress
  at it, or started after it, so its xid is at or above that xmin. Nothing is skipped.
- **Re-delivery is harmless.** Each delivery is the row's *current* state, applied as an upsert,
  so a row seen twice is applied twice to the same value.
- **A row updated mid-pull** gets a newer xid and simply appears again later.
- **Paging order.** We never order by `seq` (the gap risk the live-state changelog tolerates the
  same way).

### Replica half — `database/table-mirror/replica`

Transport-agnostic: it is handed `fetch`.

```ts
await pullReplica({
  replicaId,                       // a row of table_mirror_replicas
  fetch: { changes(req), copy(req), keys(req), rows(req) },  // → page | MirrorRefusal | transport failure (opaque, recorded)
  sink: schemaSink,                // default; site-reports passes its own (phase 4)
  budget: { pages: 20 },           // one bounded chunk; the caller re-enqueues while !done
});
withReplicaSchema(replicaId, (dbx) => runAnalyticsQuery(dbx, q, asOf));  // reads
```

- **State.** `table_mirror_replicas(id, set_id, schema, source_identity, fingerprints, floor,
  after, phase: "empty" | "copying" | "reconciling" | "live", progress jsonb, last_attempt_at,
  last_outcome jsonb, last_synced_at, source_now)`. The owner (site-mirror/pull) keys it per
  (deployment, set), with an FK cascade to the deployment.
- **`schemaSink`, the default: same DDL.**
  - The schema is named `tm_<set>_<short hash of replica id>`, which stays within the 63-character
    identifier limit.
  - Tables are created as `CREATE TABLE <s>.<t> (LIKE public.<t> INCLUDING DEFAULTS INCLUDING
    CONSTRAINTS INCLUDING INDEXES)`, minus omitted columns. The local install carries collect's
    tables in `public` already, because the demo writes through the real collect path. LIKE
    copies no FKs, so the cascade arrives as tombstones, never as a local cascade.
  - Apply: `INSERT INTO <s>.<t> SELECT * FROM jsonb_populate_recordset(NULL::<s>.<t>, $rows)
    ON CONFLICT (<pk>) DO UPDATE SET …`, then `DELETE … WHERE (<pk>) IN (tombstones)`. Values
    stay in Postgres's own text forms end to end (`to_jsonb` on the box, `jsonb_populate_recordset`
    here), so there is no JS decode or re-encode of row content.
  - **Each page is one transaction**: rows, tombstones and the advanced cursor together. It ends
    with `pg_notify('table_mirror', replicaId)`.
- **First sync (the only full copy).** A replica in phase `empty` has nothing to compare
  against, so it copies:
  1. Take `floor := xmin` of the first copy page.
  2. Page each table by PK with `readMirrorCopy`, applying each page in its own transaction and
     persisting progress, so a killed pull resumes where it stopped.
  3. Run the change stream from `floor` until `done`; the replica is now `live`.

  Until the first copy is done, readers show a pending state ("Copying… 34%"), never a partial
  list presented as the data.
- **Reconciliation (replaces a re-copy).** It runs when deltas cannot say what the replica
  missed:
  - `reconcile-required` (the floor is below the horizon: missed tombstones and updates were pruned);
  - a different source identity (a reinstalled or restored box: the cursor's xids mean nothing
    there);
  - a fingerprint change on either side (a migration may have back-filled rows without the
    triggers seeing them, e.g. `ADD COLUMN … DEFAULT`).

  Steps, in place, page by page like a delta pull (phase `reconciling`, with progress):
  1. Take `floor := xmin` of the first keys page.
  2. For each table, walk `readMirrorKeys` pages. For a page covering keys `(afterPk, lastPk]`
     (to +∞ on the last page), compare with the replica's own `(pk, h)` over the same range:
     - a local key the source does not have → delete it locally (the missed tombstone);
     - a source key missing locally, or with a different `h` → fetch it with `readMirrorRows`
       and upsert it.
     Each page's deletes, upserts and progress commit in one transaction.
  3. Run the change stream from `floor` until `done`. That covers every row changed while
     reconciling, because each such change has an xid at or above `floor`. The replica is `live`
     again.

  **Rows the source has forgotten never survive it**: a key absent from the source's walk is
  deleted. Only differing rows travel, usually a small fraction. A reconcile in progress shows
  a mix of older and newer rows, exactly as a delta pull in progress does. The freshness line
  says "Reconciling…" meanwhile.
- **Column changes.** Compatibility rule: every mirror column must exist on the source with the
  same type. Otherwise the result depends on which side is behind:
  - The **source** lacks a column. If it is nullable (its NULL is collect's "not recorded"), the
    hash covers the shared columns only and the column stays NULL. If it is NOT NULL, refuse
    with `{ kind: "source-older" }` ("deploy the site again").
  - The source has **extra** columns. Ignore them; local code does not read them.
  - **This computer's own table changed** (a local migration of `public.<t>`). Rebuild that
    mirror table locally, with no network: create it again `LIKE public.<t>`, copy the shared
    columns from the old one with `INSERT … SELECT`, and swap the two tables in one transaction.
    Then reconcile, which fetches only the rows whose values in the new column differ.
- **Orphans.** Each pull job run drops `tm_*` schemas that have no replica row (a deleted
  deployment).
- **Change signal.** `onReplicaApplied(setId, fn)`: the replica plugin LISTENs on
  `table_mirror`. Consumers' served values and collections are `changes: "notified"` and call
  `served.notify()` from it. This is push-based: the apply transaction itself announces the change.

### Deployment glue — `apps/deploy/site-mirror`

- **`box`** registers, under `hostOnly`:
  - `GET /api/host-only/table-mirror/changes?q=<base64url>`
  - `GET …/copy?q=…`

  It needs no allowlist of sets; the source registry is the allowlist. An unknown set answers
  `unknown-set`. Older releases answer 404, which `hostOnlyQueryOverSsh` already maps to
  `route-missing` ("deploy it again").
- **`pull`:**
  - **Replicas.** It keeps one replica per (deployment, set) for each set whose plugin the
    deployment's closure ships (`useDeploymentShips`'s server-side twin).
  - **Transport.** `hostOnlyQueryOverSsh(…, MirrorPageSchema, { maxAnswerBytes })`. Every
    `HostQueryFailure` is stored as-is in `last_outcome`.
  - **Job `site-mirror.pull`.**
    - `defineJob` with `dedup: { key: replicaId }`, so a second request while one is pending
      coalesces.
    - Each run is one bounded chunk (`budget.pages`) that re-enqueues itself while the replica is
      not `done`, so no run is long and an initial copy is resumable.
    - Its scheduled sibling `site-mirror.pull-all` runs **hourly with no `perWorktree`, which
      means main only**, and enqueues a pull for every replica.
  - **Endpoint `POST /api/site-mirror/sync { deploymentId, setId? }`** enqueues a pull. It is
    called on tab open (once per mount, when `last_synced_at` is older than a few minutes) and by
    Refresh / Sync now. It is a write, so it is not a read hidden in an endpoint.
  - **Live value `site-mirror.status`.** For each deployment and set: `phase`, `progress`,
    `last_synced_at`, `last_outcome`. It is notified on apply and on outcome.
  - **Web: `<MirrorFreshness deploymentId setId />`.** Shown in each consumer's header:
    - "Synced 12 min ago · Sync now";
    - "Copying… 34%" during the first sync, "Reconciling…" while reconciling;
    - on failure, `HostQueryFailureState` (reused) above the still-readable older data: "showing
      data synced 3 h ago";
    - before the first copy, a pending state, never an empty list. This follows
      not-known-yet-is-a-state.

### Worktrees and forks

- **Main owns the scheduled sync.** The hourly job is main-only.
- **The fork excludes the mirror.** `tm_*` schemas and `table_mirror_replicas` rows are declared
  fork-excluded, through a schema-level exclusion like graphile's (`fork-plan.ts` reports
  undeclared schemas today). The mirror can be large: forever totals for every deployment.
  `pg_dump | pg_restore` into roughly 230 forks would multiply it.
- **What a fork sees.** An empty mirror, with "Not synced yet · Sync now" on open. Opening the tab
  in a worktree enqueues its own pull, which copies into the worktree's own database, the same as
  today's per-read SSH from a worktree. No schedule runs in a fork.
- **Alternative (open decision 2).** Copy the mirror with the fork, so a worktree has data at once
  and continues incrementally (xids are cluster-wide, so the copied cursor stays valid). It costs
  fork time and disk for every fork.
- **Demo stand-in box.** The "box" is this instance, so source and replica share one database.
  They do not collide: the source writes `public.*` and `table_mirror_log`, and the replica writes
  `tm_*`. The source triggers are installed locally too, because collect ships in the local app.
  This is what makes demos work unchanged.

### Sizes and batching

- **Page bounds.** At most `maxRows = 2000` and `maxBytes = 4 MB` per page, whichever comes first.
  The answer cap is enforced on the box (the running byte sum) and here (`maxAnswerBytes`
  re-checked). One page must answer within curl's 10 s deadline. The log index makes a page an
  index range scan, and the copy is a PK keyset.
- **Rough cost.** One SSH session per page, about 1 s. At about 1k visits/day × 5 hits, the 90-day
  raw window is about 550k rows, which is about 275 pages, which is about 5 min of pulls in 20-page
  chunks. The forever tables add more.
- **Measure before building.** Phase 1's first step counts rows and bytes per table on the real
  site's box. If the copy is too slow, the fix is a streaming transport (one SSH session carrying
  many pages as ndjson). That changes only `site-mirror/pull`'s `fetch`, not the primitive.
- **Incremental pulls.** An hour of changes is usually one page.
- **Trigger cost on the box.** One extra `INSERT … SELECT … ON CONFLICT` per write statement on a
  mirrored table. A pageview already updates its visit row in the same transaction, so the log's
  row lock adds no new contention.

## Phase 1: the primitive, with collect's tables as its first set

1. `database/table-mirror` (`core`, `source`, `replica`) as above, plus the `NeverMirrored`
   declaration.
2. collect declares the `analytics` set and marks salts and visitor links never-mirrored.
3. `apps/deploy/site-mirror` (`box`, `pull`): routes, replicas, job, endpoint, status value,
   freshness line, fork exclusion.
4. Tests (bun, a throwaway DB via `database/db-test-fixture`, with source and replica in one DB
   in two schemas):
   - Upserts, updates and deletes round-trip.
   - A retention sweep on the source, with its cascade, removes visits **and hits** in the mirror.
   - A mirror pruned past the horizon reconciles: the rows deleted on the source while it was
     away are gone, rows updated meanwhile carry their new values, and the rows that did not
     change are not transferred again (count what `readMirrorRows` fetched).
   - Identity, epoch and fingerprint changes cause a reconciliation. A new nullable column on
     the source fetches only rows with a non-NULL value in it.
   - The row hash agrees on both sides for every column type collect uses (timestamptz under
     different session time zones, jsonb, bigint, text PKs under different collations).
   - An in-flight transaction across a pull is not skipped (two connections: hold a write open
     while a pull runs, commit it, pull again).
   - A page respects both bounds.
   - Listing a never-mirrored table throws.

Nothing reads the mirror yet. It fills, and its freshness line can be checked in the Deploy app.

## Phase 2: Sessions reads the mirror as a live collection

- **Collection.** `deploymentSessions` becomes a `liveCollection` (no `from`: `source:
  "external"`, own `fields`) with params `{ deploymentId }`, and replaces the paged `liveValue`.
  - Row: the visit columns plus `durationMs` and the hits.
  - Default order: `startedAt desc, id`.
  - Limits: `limit 50`, `maxLimit 100`.
- **Why the external arm.** The `serveCollection` SQL arm needs an Entity `from`, and these are
  raw `pgTable`s in a per-replica schema. So the collection is served with the external arm
  (`window`, `rows`, `groups`, `count`, `keyText`), and every callback runs **collect's own
  sessions SQL** through `withReplicaSchema`.
- **Collect's changes.** collect's `sessions.ts` gains a `where` input: the filter-language tree
  that `liveDataSource` lowers DataView filters into.
  - collect owns `visitFilterSql(where)`, which maps each field to a visit column (`channel`,
    `country`, `device`, `browser`, `os`, `returning`, `owner`, `entryPath`, `exitPath`,
    `referrerHost`, `utm*`, `pageviews`, `events`, `durationMs`, `startedAt`) through `filterSql`.
  - Membership dimensions (`page`, `event`, `event_prop`) map to collect's existing `visitHasAll`
    EXISTS. That keeps one filter dialect, the report's membership definition.
  - `sessions.ts` keeps the `(started_at, id)` keyset walk. `groups` and `count` are collect
    functions over the same `base`.
- **What replaces the hand-rolled strip.**
  - **Shape** (All / With actions / 2+ pages / Bounced) becomes **built-in saved views**, each a
    filter (`events > 0`, `pageviews >= 2`, `pageviews <= 1 AND events = 0`). They sit in the view
    bar, and the active view is in the URL (`;view.<storageKey>`). Per-view counts are the
    collection's `count` with each view's filter. That replaces `analyticsSessionCountsEndpoint`.
  - **Audience** becomes the `owner` field. The default views filter `owner = false`
    ("visitors"), and "You" / "All" are filter presets.
  - **Range** becomes a `startedAt` filter. If the filter language's instant domain has no
    relative operator ("in the last 7 days"), add one to the domain generically, never a
    Sessions-only control. The 90-day bound needs no code: the mirror simply holds what the
    source still has.
  - The fields' `filterable` flags become real. Search goes server-side through `searchable`.
    The table view and group-by come for free.
- **Change signal.** `changes: "notified"`, with `notify()` from `onReplicaApplied("analytics")`.
- **Removed.**
  - The box endpoints `analyticsSessionsEndpoint` / `analyticsSessionCountsEndpoint`. Nothing
    calls them once the local app has moved; old releases keep serving them to no one.
  - `sessions-toolbar`'s strip and the `useState` question.

## Phase 3: the Analytics report and the Overview cards read the mirror

- **Serving.** `deploymentAnalyticsServed`'s loader becomes
  `withReplicaSchema(replica, dbx => runAnalyticsQuery(dbx, query, asOf))`. It is
  `changes: "notified"` through `onReplicaApplied`. There is no second implementation; collect
  exports `runAnalyticsQuery` from its server barrel (collect already ships in the local app).
- **`asOf` is the source's `now` at the last applied page**, not this computer's clock. The report
  is then exactly what the box would have answered at that moment: today's partial day and the
  live-visit cutoff included. The freshness line says when that was.
- **Overview cards.** The Traffic / Top cards read the same value with `OVERVIEW_QUERY`, so they
  move with it.
- **Range and filters into the URL.** The dashboard's range, compare, filters, audience and metric
  move out of `useState` into the URL or a saved view, the same as Sessions.
- **Parity test** (collect's `analytics.db.test.ts`, extended):
  1. Seed `public` through `recordCollect`, run `runRollup` and a retention sweep.
  2. Mirror it in-process (source and replica in one DB, `fetch` = direct calls).
  3. Assert `runAnalyticsQuery(public) ≡ runAnalyticsQuery(mirror)` for each fixture query: every
     range including `12m` (`totals` source), filters, audiences, and compare.
  4. Same for the sessions window.
- **Fail-loud guard.** The mirror's search path is `<schema>, pg_catalog`, without `public`, so a
  collect query that ever names an unmirrored table, such as salts, fails instead of silently
  reading local demo data.
- **Retired.** `analyticsQueryEndpoint` stays on the box while any other consumer remains;
  otherwise it is retired too.

## Phase 4: site-messages and site-reports

### site-messages/inbox: a plain mirror

- **Set.** site-messages/intake declares the set `site-messages` = `site_messages`, with
  `omit: ["ip_hash"]`. The salted IP hash stays on the box, like collect's salts. The salt table
  `site_messages_salt` is `NeverMirrored`.
- **Mutable rows.** The notify and confirm jobs update rows, and the trigger logs every update.
- **Deletions.** The spam retention (30 days) reaches the mirror as tombstones. There is no local
  rule.
- **Inbox.** It becomes a live DataView over the mirror (external arm, `withReplicaSchema`). Verdict
  becomes switcher sources or views (Inbox / Spam). The 200-row cap is gone, and search runs over
  every message.
- **Bounds.** Message text is stranger-written. It is rendered as text nodes (unchanged). The page
  byte cap bounds each transfer, and the intake's own caps bound row size.
- **Retired.** The host-only list route `GET /api/host-only/site-messages`.

### site-reports/import: the change stream, with the reduce step as its sink

**Decision: raw `site_reports` rows are never stored on this computer.**

- **Why.** `import/CLAUDE.md`'s T3 says "The site's `data` is never copied". The message is
  reduced to one plain line, and so on. A same-DDL mirror would store exactly what those rules
  forbid: free text and arbitrary `data` jsonb from strangers, readable by any local query and
  any agent's `query_db`.
- **What it uses instead.** site-reports takes the primitive's change stream (cursor, paging,
  tombstones, horizon, reconciliation) and passes its own **sink** in place of `schemaSink`:
  `reduceSink.apply(page)`. For each upsert, it strictly parses the row (`SiteReportRecord`), runs
  `reduceSiteReport`, then calls `recordReportIncident`, with one incident per pull and the same
  cursor commit transaction.
- **Rules still in force.** Untrusted source, fencing, never auto-investigated, text-only rendering
  and the 24 h cooldown are all unchanged.
- **T6 flood bound.** The set's page is `maxRows = 50`, with **one page per run**. A backlog
  drains 50 an hour, as today. Unlike today, nothing is skipped: the xid cursor replaces the
  `lastSeenAt` watermark, which lost rows that fell off the 100-row page.
- **Transfer bounds.** The 1 MB `maxAnswerBytes` stays.
- **Tombstones.** The box's 30-day retention deleting a fingerprint is ignored by this sink. The
  local report is an incident record with its own engine retention, not a copy of the box's
  table.
- **Reconciliation.** This sink keeps no raw rows to hash, so the replica keeps, for any custom
  sink, a key index `table_mirror_keys(replica_id, tbl, pk, h)`: the key and the row hash of
  everything applied, no content. Reconciliation compares against it. Only rows whose hash
  changed are fetched and handed to the sink with `{ reconciling: true }`, which records without
  notifying, so a reconciliation rings no bells and does not inflate the local recurrence count.
- **Removed.** `site_report_imports` (its watermark moves into the replica row) and the hourly
  `site-reports.import` job. The pull-all job covers the set.
- **Primitive requirement.** The sink interface is part of phase 1's replica API: `apply(page,
  { reconciling })` plus, for the default `schemaSink`, `keyHashes(table, range)` read from its
  own tables. A custom sink gets the replica's key index instead. So phase 4 adds no new concept
  to the primitive.

## Verification (per phase, for the implementers)

- `./equin test plugins/database/plugins/table-mirror plugins/apps/plugins/deploy/plugins/site-mirror`
  for the round-trip, cascade, horizon, reconciliation, in-flight and bounds tests above.
- **Phase 1 end to end.**
  1. `./equin build`, then open a demo deployment (stand-in box) in the Deploy app.
  2. The freshness line goes "Copying…" → "Synced just now".
  3. `query_db` on `tm_analytics_*` shows the rows, and no `analytics_salts` table.
  4. Delete a visit in the demo's `public`, then Sync now: the visit and its hits are gone from
     the mirror.
- **Phases 2 and 3.**
  - The parity test.
  - `screenshot.ts --path` on the Sessions tab, filtering by country and by visited page. The
    filter shows in the URL, and the counts per view are right.
  - The Analytics tab renders from the mirror with SSH unreachable (point the server at a dead
    host). It shows the failure state above the last-synced data.
- **Phase 4.**
  - Inbox lists more than 200 messages.
  - A spam row aged past 30 days on the box disappears locally.
  - A site-report injected with markup or a prompt in `data` is reduced exactly as today (the
    existing reduce tests), and no local table holds its raw text: `query_db` for the string
    finds nothing.

## Open decisions

1. **Tombstone / log retention on the box** (`TOMBSTONE_RETENTION_DAYS`). Proposed: 30 days,
   meaning a computer off for longer reconciles (keys and hashes, plus the rows that differ).
2. **Forks.** Proposed: exclude the mirror from forks; a worktree pulls its own copy on open.
   Alternative: copy the mirror with the fork.
3. **Transport.** Proposed: one SSH session per page (reuses host-query unchanged). Upgrade to a
   streaming transport only if the measured initial copy is too slow.
4. **Report clock.** Proposed: `asOf` = the source's `now` at the last applied page, for exact
   parity. Alternative: this computer's clock, which shows "today" moving although no data has
   arrived.

## Implementation tasks (ordered)

1. **Measure**: row and byte counts per collect / site-messages / site-reports table on the real
   site's box. This picks the page bounds and confirms open decision 3.
2. **`database/table-mirror` core + source**: log, generated triggers, identity, readers
   (changes, copy, keys, rows; the row hash), horizon prune job, `NeverMirrored`, and tests
   including cascade and in-flight.
3. **`database/table-mirror` replica**: replica table, `schemaSink`, first copy, reconciliation, local table rebuild, key index for custom sinks, sink
   interface, `withReplicaSchema`, `onReplicaApplied`, fork exclusion, orphan sweep, and tests.
4. **`apps/deploy/site-mirror`** (`box` routes + `pull` job / endpoint / status / freshness line),
   with collect's `analytics` set declared. Deploy a site release carrying the source half.
5. **Sessions on the mirror**: collect's `where` / `visitFilterSql` / groups / count, the external
   live collection, shape as views, audience and range as filters in the URL, toolbar removed.
6. **Analytics + Overview on the mirror**: the loader through `withReplicaSchema`, `asOf`, URL
   state, and the parity test.
7. **site-messages on the mirror**: the set with `omit`, and the inbox DataView.
8. **site-reports on the change stream**: `reduceSink`, removal of `site_report_imports` and the
   old job.
9. **Cleanup**: retire the box endpoints no consumer calls any more.

Tasks 5–8 depend on 4. Tasks 5 and 6 can run in parallel, and so can 7 and 8.
