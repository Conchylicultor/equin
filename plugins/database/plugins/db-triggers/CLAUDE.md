# db-triggers

**The one trigger installer.** Every trigger the app declares goes through it:
an invariant a plugin needs **the database** to keep (one write must always
come with another, a commit must never leave some state), a table's derived
`updatedAt` (`database/derived-updated-at`), a rollup's maintain functions and
source triggers (`database/derived-tables`), graphile's superseded-row trigger
(`infra/jobs`), the change feed's per-table NOTIFY triggers
(`network/live/change-feed`). One protocol, so one drift and repair story.

```ts
export const clusterTriggers = defineDbTriggers({
  id: "tasks.cluster",
  functions: [{ name: "tasks_union_clusters", args: "text, text", ddl: `CREATE OR REPLACE FUNCTION tasks_union_clusters(…` }],
  triggers: [{ name: "…", table: "task_dependencies", ddl: `CREATE OR REPLACE TRIGGER … ON task_dependencies …` }],
});
// server definition: contributions: [DbTrigger(clusterTriggers)]
```

- **`defineDbTriggers`** asserts at module eval that each DDL creates exactly
  the function / trigger it is named, in its `schema` (default `public`; the
  DDL must name any other), and that the trigger is `ON` its table — the
  installer's catalog reads go by those names. A set id is `[A-Za-z0-9_.-]`
  (it is a field of every stamp). `beforeInstall(exec)` is an optional assert
  run before any of the set's DDL whenever it has something to (re)install (a
  rollup's `select` against its declaration).
- **Per-object stamps.** Each function and trigger the installer writes gets
  the COMMENT `db-triggers:<set id>:<sha256 of its DDL>:<md5 of its catalog
  definition>` — the last read with `pg_get_functiondef` / `pg_get_triggerdef`
  right after the DDL ran. So "installed as written" is a catalog-only read
  (no table lock), and it sees what a comment alone cannot: an object replaced
  out of band, whose `CREATE OR REPLACE` kept the OID and with it the comment
  (an older build reinstalling its own maintain function on a fork, a trigger
  altered by hand). A dropped object took its stamp; a disabled trigger counts
  as stale. Only stale objects re-run: a changed function body is one
  `CREATE OR REPLACE FUNCTION`, no table lock.
- **Adopting an older installer's work.** A trigger carrying the COMMENT an
  older installer left for this very DDL — its declared `legacyStamp` (the
  derived-`updatedAt` signature, the superseded trigger's, `null` for a rollup
  trigger whose `triggers:<table>` state row matches), or this installer's
  first `<id>:<sha of the set>` stamp — is restamped (COMMENT only, SHARE
  UPDATE EXCLUSIVE, which no writer waits on), never re-created. Without it the
  first boot of the one installer would take SHARE ROW EXCLUSIVE on every
  trigger-bearing table at once during a hot swap. Compatibility only: drop
  `legacyStamp` and the first-stamp recognition once no supported database
  predates the per-object stamps.
- **Ownership and removal.** A set owns what carries its stamp and every
  trigger calling one of its functions; what it owns but no longer declares is
  dropped (a stray trigger, a removed source's) — triggers first, then the
  functions. With `{ sweep: { schema } }` the caller declares EVERY set living
  in that schema, and a set stamped there that nobody declares any more (a
  removed rollup, a removed table's `updatedAt`) is dropped whole and reported
  `dropped`. `keep` (a predicate over `{ schema, table, name }`) leaves an
  owned-but-undeclared trigger in place instead — the expand half of a removal
  that earlier-booted code still relies on — reported as the set's `kept`
  count; while one is kept no function is dropped, and a later install without
  `keep` drops it (the change feed's deferred removal). A set its plugin installs by its own call is claimed with
  `DbTriggerClaim({ id, reason })` and passed as `sweep.installedElsewhere`,
  which the sweep spares (a claimed id also declared in the call throws). Only
  the boot schema layer passes a sweep (`public`): its list is
  complete for this database, because a namespace's registry and its database
  are selected together (`server-core/CLAUDE.md`, the pairing that also scopes
  `sweepUnusableSnapshots`). A removed rollup's TABLE is not dropped here: the
  previous backend still reads it during a hot swap; `orphaned-db-tables`
  reports it. An OLDER build booting on a fork of a newer database sweeps the
  newer sets it does not know (their triggers stop until the branch rebases
  and boots again, which reinstalls them and reconciles the rollups).
- **One lock order (C12).** A trigger change takes SHARE ROW EXCLUSIVE on its
  table (a drop, ACCESS EXCLUSIVE), held until the boot schema layer commits —
  savepoints release nothing — while the previous backend still writes. So the
  installer takes tables in ONE fixed order across every set (by
  `<schema>.<table>`, one savepoint each): a writer in that order and the
  installer only ever wait one way. A writer in another order can close a
  cycle; Postgres aborts one side, and when that is the installer it fails
  loudly naming the table (`migrations/check/internal/rollup-boot-order.test.ts`).
  A current table takes no lock at all.
- **`commit: "per-table"`** (on the pool; a transaction is refused): the
  functions commit first, then each table's triggers in their own
  transaction (same fixed order), then function drops. The install never
  holds two tables' locks, so it cannot be part of a lock cycle at all —
  for a set spanning every table, installed outside the schema layer (the
  change feed's). `beforeInstall` runs with the functions. Each table's
  transaction re-plans from **that table's triggers only**
  (`readTableCatalog`): its slice of the plan reads no function row, so the
  install is O(changed tables), not O(tables × catalog) — re-reading the whole
  catalog per table was 70 % of a fresh PGlite boot's SQL (step 9,
  `research/2026-11-06-global-build-pipeline-step9-fresh-boot-and-snapshot-key.md`).
- **Comments are joined, never called.** The catalog reads join
  `pg_description`; `obj_description()` is a query per row, and as a filter
  over `pg_proc` it ran once for each of ~3,000 built-in functions.
- **Serialized and asserted.** Stale sets are installed under a
  transaction-scoped advisory lock per set (two-int form, in id order), re-planned
  under them; then every set is asserted current, or the install throws — a
  boot never proceeds without an invariant its plugin declared.
- **Plain, immediate triggers only.** No CONSTRAINT trigger: Postgres cannot
  replace one in place, and the change feed refuses a DEFERRED trigger on any
  table it routes (a write it makes would notify after the transaction's end
  marker). A check runs at the end of its statement instead.
- **Forks keep their data**: pg_dump writes triggers in post-data, so a dump /
  restore loads the rows before any trigger exists.

## Who calls it

- **The boot schema layer** (`migrations/server`'s `applySchemaLayer`), ONE call
  in its one transaction, after the migrations and the rollup tables and before
  the rollup reconcile: every `DbTrigger` contribution, every registered derived
  `updatedAt` spec's `triggerSet`, every rollup's `rollupTriggerSet`, with
  `sweep: { schema: "public" }`.
- **`infra/jobs`' `installQueueSchema`**, for the superseded-row trigger on
  `graphile_worker._private_jobs` — after graphile's own migrations, which
  create that table, on every database that gets a queue schema. No sweep.
- **`network/live/change-feed`'s `rebuildTriggers`**, in its
  `onReadyBlocking` (after the schema layer committed): the `change-feed` set
  — both notify functions and three triggers per triggered table, derived
  from the booted resource registry — with `commit: "per-table"`. Never in
  the schema layer's call: the layer's dry run (`migration-applies-clean`)
  cannot build that registry, and holding ~200 tables' locks until the
  layer commits would make a cycle with the previous backend's writers merely
  loud instead of impossible. Claimed with `DbTriggerClaim`. Its end marker
  (a deferred CONSTRAINT trigger) stays hand-installed.
- **A test**, `installDbTriggers(db, [set])` on a throwaway database (after
  `runMigrations`); `installRollups` for rollups.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The one trigger installer: defineDbTriggers names a set of plpgsql functions and the triggers that call them (asserted at module eval to create what they are named, schema included), contributed as DbTrigger (or claimed with DbTriggerClaim by a plugin installing a set itself, which the schema layer's sweep then spares); installDbTriggers installs every declared set — a plugin's invariants, the derived updatedAt triggers, the rollups' maintain triggers, graphile's superseded trigger, the change feed's NOTIFY triggers — by one protocol: a per-object stamp in each COMMENT (DDL hash + catalog-definition hash, so an out-of-band replacement is seen), only stale objects re-run, every table in one fixed order one savepoint each (or, commit: "per-table", one transaction each), owned-but-undeclared objects dropped (a whole removed set under sweep), advisory-locked, asserted after.
- Server:
  - Uses: `primitives/log-channels.defineLogSink`
  - Exports (types):
    - `DbFunctionDdl`
    - `DbTriggerClaimSpec`
    - `DbTriggerDdl`
    - `DbTriggerInstall`
    - `DbTriggerSet`
    - `InstallDbTriggersOptions`
    - `KeepTrigger`
  - Exports (values):
    - `DbTrigger`
    - `DbTriggerClaim`
    - `defineDbTriggers`
    - `installDbTriggers`
- Cross-plugin:
  - Imported by:
    - `database`
    - `database/derived-tables`
    - `database/derived-updated-at`
    - `database/migrations`
    - `infra/jobs`
    - `network/live/change-feed`
    - `shell/notifications`
    - `tasks/tasks-core`

<!-- AUTOGENERATED:END -->
