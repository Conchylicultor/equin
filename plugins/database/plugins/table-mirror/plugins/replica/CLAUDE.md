# table-mirror/replica

The replica half of the table mirror (`../../CLAUDE.md`). Runs where the copy
lives (this computer). Transport-agnostic: the owner hands it `fetch`.

```ts
await ensureReplica(db, { id, set: analyticsMirror });          // sink "schema" (default) | "custom"
const r = await pullReplica({
  db, replicaId: id, set: analyticsMirror,
  fetch: { changes, copy, keys, rows },  // → page | MirrorRefusal | { kind: "fetch-failed", failure }
  budget: { pages: 20 },                 // one bounded chunk; pull again while !r.caughtUp
  sink,                                  // only for a "custom" replica (site-reports' reduce step)
});
const read = await withReplicaSchema(db, id, (tx, { sourceNow }) => runAnalyticsQuery(tx, q, sourceNow));
// read: { ready: true, value, sourceNow } | { ready: false, phase, progress }
const stop = onReplicaApplied("analytics", (replicaId) => served.notify());
```

- **State** — `table_mirror_replicas` (one row per replica, keyed by the
  owner's id): `phase` (`empty` → `copying` → `live`, `reconciling` when
  deltas cannot be trusted), `progress` (`tables`: the table and last key
  done; `stream`: catching up from the pass's floor), the identity and
  fingerprints the pass was read under, the cursor (`floor`, `after`,
  `pass_xmin` — the first stream page's xmin, the next floor once `done`),
  `copied_at` (a whole copy was first in place — what readers wait for),
  `source_now` (the source's clock at the last applied page: the copy's "as
  of"), `last_synced_at`, `last_attempt_at`, `last_outcome` (`synced` |
  `stopped` | `refused` | `fetch-failed` | `source-older`).
- **Every step is one transaction**: the replica row moves (`seq` guarded —
  a second pull of the same replica throws `ConcurrentPullError` instead of
  interleaving), the sink applies the page, `pg_notify('table_mirror',
  {replicaId, setId})`. A killed pull resumes where it stopped.
- **The schema sink** (default): schema `tm_<set>_<hash of id>` (≤ 60 chars),
  one table per mirrored table, `CREATE TABLE … (LIKE public.<t> INCLUDING
  DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)` minus omitted columns.
  No FKs (a cascade arrives as tombstones), no triggers (not in `public`, so
  not in the change feed). **Unique / exclusion constraints are relaxed to
  plain indexes**: a copy passes through states the source never had (a
  value moved between two rows applied in one statement, a reconcile page
  ahead of the range still holding the old value).
  - Apply: tombstones `DELETE … WHERE (pk) IN (jsonb_populate_recordset …)`,
    then `INSERT (cols) SELECT cols FROM jsonb_populate_recordset(NULL::<s>.<t>,
    $rows) ON CONFLICT (pk) DO UPDATE`, `cols` = the columns both sides have.
    Rows arrive as the source's jsonb TEXT (core's `MirrorRow`) and are joined
    into one array literal: never a JS value in between, so a `numeric`'s
    scale, a jsonb `2.0` and a `bigint` past 2^53 arrive exactly and hash
    equal (pinned by the "values JSON cannot hold" test).
    A column the source lacks keeps its default on insert and its value on
    update; one it has extra is ignored; one this computer requires (NOT NULL,
    no default) that the source does not send is the outcome `source-older`,
    with nothing applied.
  - **Local rebuild**: at each pull's start the copy's fingerprint (the
    source's catalog digest, over the replica schema) is compared with
    `public.<t>`'s. A difference (a local migration) rebuilds the table in
    one transaction, no network: the old table moved to a scratch schema, a
    new one made LIKE public, the shared columns copied by name (a changed
    type cast), the scratch dropped. Rows are kept when every key column
    survives and every new column is nullable or defaulted, and the copy (in a
    savepoint) succeeds; otherwise the table starts empty, `copied_at` is
    cleared, and the reconcile refills it. A created or
    rebuilt table (or one added to the set) makes the replica reconcile.
- **First sync** (`empty`): every table paged by `readMirrorCopy`, the floor
  the first page's `xmin`, then the stream until `done` — the only full copy.
  `withReplicaSchema` answers `ready: false` until then (`copied_at`), also
  when the source changed mid-copy and the replica reconciles the partial
  copy instead.
- **Reconciliation**: on `reconcile-required`, another identity or epoch, a
  fingerprint change on the source, or a local table created / rebuilt. Per
  table, per keys page `(afterPk, lastPk]`: the copy's own `(pk, h)` over the
  same range and the same columns (the source's hash expression, under
  `TimeZone = 'UTC'`); local keys the source lacks deleted, differing or
  missing ones fetched with `readMirrorRows` (in chunks, `remaining` asked
  again, `missing` deleted) — the page's deletes, upserts and progress in one
  transaction. Then the stream from the pass's floor. A source that changes
  identity or fingerprints mid-pass restarts the reconcile, and so does a
  pass whose current table the set no longer lists.
- **A custom sink** (`sink: "custom"`): no schema; the owner's
  `apply(tx, batch, { reconciling, firstCopy })` runs in the page's
  transaction, and the replica keeps the **key index** `table_mirror_keys
  (replica_id, tbl, pk, h)` — key and hash of every applied row, no content —
  which a reconciliation compares against (keys typed by `public.<t>`'s row
  type for the source's order). The hash kept covers this install's columns
  only (recomputed from the row text when a newer source sends more), as the
  keys page's does. **The sink is handed each row content once**: only the
  upserts whose hash the index did not hold (`ON CONFLICT … WHERE h IS
  DISTINCT FROM excluded.h RETURNING`), so a re-delivery — the stream re-reads
  from its floor, and the stream after a copy or reconcile re-reads rows the
  pass already applied — never reaches it; tombstones are all handed. A sink
  that counts what it is handed (site-reports' recurrences) counts truthfully.
- **No retention here.** Deletions — cascades, the source's retention, rows
  deleted while the replica was past the horizon — reach the copy only
  through the sync (tombstones, or a reconcile's deletes).
- **`withReplicaSchema`**: a read-only REPEATABLE READ transaction with
  `search_path = <schema>, pg_catalog` — no `public`, so the owner's own SQL
  runs unchanged on the copy and a table the set does not mirror fails
  instead of reading this computer's rows. `fn` gets the copy's `sourceNow`
  (a `Date`): a read that depends on time asks it of the copy's moment.
- **Ownership**: `dropReplica` (schema + row + key index, one transaction);
  `sweepOrphanReplicaSchemas` drops every `tm_*` schema no row names (the
  `tm_` schema namespace is this plugin's) — schemas listed before rows, so a
  replica created meanwhile is never swept.
- **Forks**: `table_mirror_replicas` and `table_mirror_keys` are
  `ExcludeFromFork`, `tm_*` is `ExcludeSchemaDataFromFork` with `keep: []`:
  a fork has empty `tm_*` schemas and no replicas, pulls its own copy on open,
  and the sweep drops the empty schemas.
- **Change signal**: `onReplicaApplied(setId, fn)` LISTENs on `table_mirror`
  through the host's `DatabaseDriver.listen` while anyone is subscribed;
  `fn(null)` after a lost session (a notice may have been missed).

Tests: `server/internal/replica.db.test.ts` — source and replica in one
throwaway database, `fetch` the source's readers in-process (counting what
travels): paged first copy, round trips, a cascade and a retention sweep, a
moved unique value, reconcile past the horizon (deletes gone, only differing
rows fetched), an epoch change, an in-flight write, the NOTIFY, concurrent
pulls, a local rebuild fetching only rows whose new column differs,
`source-older`, exact numeric / jsonb / bigint values, an unfinished first
copy that stays unreadable through a reconcile, the custom sink's key index
(and re-deliveries never handed to it),
drop and sweep.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The table mirror's replica half: one Postgres schema per replica (tm_<set>_<hash>) holding tables LIKE the local install's own (unique constraints relaxed, no foreign keys), filled by pullReplica — a transport-agnostic, budgeted pull that applies each page together with its cursor in one transaction (NOTIFY table_mirror at commit): a first copy, then the delta stream; key + hash reconciliation (deleting keys the source no longer has, fetching only rows whose hash differs) when deltas cannot be trusted — reconcile-required, another source identity or epoch, a source fingerprint change, a table created or rebuilt locally (LIKE + INSERT … SELECT + swap); a custom sink in place of the schema, backed by the content-free key index table_mirror_keys; withReplicaSchema runs the owner's own SQL on the copy (search_path = the replica's schema, pg_catalog); onReplicaApplied is the change signal; replicas and their schemas are left out of worktree forks.
- Server:
  - Contributes:
    - `fork-data-exclusion` "table_mirror_keys"
    - `fork-data-exclusion` "table_mirror_replicas"
    - `fork-schema-data-exclusion` "tm_*"
    - `change-feed-exclusion` "table_mirror_keys"
  - Uses:
    - `database.DatabaseDriver`
    - `database.ListenSession`
    - `database/admin.ExcludeFromFork`
    - `database/admin.ExcludeSchemaDataFromFork`
    - `database/sql-column.parsedJson`
    - `database/sql-column.parsedText`
    - `database/table-mirror/source.MirroredTable`
    - `database/table-mirror/source.MirrorSetDefinition`
    - `database/table-mirror/source.mirrorSql`
    - `database/table-mirror/source.readTableFingerprints`
    - `ids.externalIdColumn`
    - `network/live/change-feed.ExcludeFromChangeFeed`
  - DB schema:
    - `plugins/database/plugins/table-mirror/plugins/replica/server/internal/schema-sink.ts`
    - `plugins/database/plugins/table-mirror/plugins/replica/server/internal/tables.ts`
  - Exports (types):
    - `EnsureReplicaOptions`
    - `MirrorCustomSink`
    - `MirrorFetch`
    - `MirrorFetchFailed`
    - `MirrorSinkBatch`
    - `PullReplicaOptions`
    - `PullResult`
    - `ReconcileReason`
    - `ReplicaAppliedHandler`
    - `ReplicaOutcome`
    - `ReplicaPhase`
    - `ReplicaProgress`
    - `ReplicaRead`
    - `ReplicaSinkKind`
    - `ReplicaTx`
  - Exports (values):
    - `ConcurrentPullError`
    - `dropReplica`
    - `ensureReplica`
    - `onReplicaApplied`
    - `pullReplica`
    - `sweepOrphanReplicaSchemas`
    - `tableMirrorReplicas`
    - `withReplicaSchema`
- Cross-plugin:
  - Imported by:
    - `apps/deploy/analytics/sessions`
    - `apps/deploy/site-mirror/pull`
- Exemptions:
  - Exempts itself from:
    - `sql-writes:fit:hand-written` — `server/internal/schema-sink.ts` (sanctioned)
    - `sql-writes:fit:dynamic` — `server/internal/schema-sink.ts` (sanctioned)
    - `imperative-create-table-allowlisted` — `server/internal/schema-sink.ts` (sanctioned)

<!-- AUTOGENERATED:END -->
