# The change feed's NOTIFY triggers and the one trigger installer

Task: task-1793863056-9ddq5o. Follows task-1793859224-2e5lyj, which made
`database/db-triggers` the installer for every other declared trigger.

## Question

`network/live/change-feed`'s `rebuildTriggers` still installs the per-table
NOTIFY triggers by itself. It has its own signature table
(`live_state_trigger_state`), DROP+CREATE per table, one transaction per
table and its own repair story. Can those triggers be `db-triggers` sets, or
why not?

## Decision

**Yes, they can be sets. They must NOT join the boot schema layer's
`installDbTriggers` call. They become a second call to the same installer,
made by the feed. That call needs two installer features it lacks today:**

1. **A scoped sweep.** The schema layer's sweep must leave alone a set some
   other call installs.
2. **A per-table commit mode.** Each table is its own transaction, not a
   savepoint of one long transaction.

Two objects stay outside, each for a reason the installer already states:

- the end marker `live_state_txn_end`. It is a deferred CONSTRAINT trigger,
  which `db-triggers` refuses because Postgres cannot replace one in place.
- the changelog's table, index and later columns. These are table DDL, not
  triggers.

The design below was implemented in the same task (see *As landed*).

## What fits

- **Functions.** `live_state_notify()` and `live_state_notify_routed()` are
  argument-less plpgsql functions defined with `CREATE OR REPLACE FUNCTION`.
  That is `DbFunctionDdl` exactly.
- **Triggers.** There are three plain STATEMENT-level AFTER triggers per
  table, each with transition tables. `CREATE OR REPLACE TRIGGER … REFERENCING
  … FOR EACH STATEMENT` is already what the rollups' source triggers install
  (`derived-tables/core/internal/define-rollup.ts`). A routed table's layout
  rides the trigger arguments, so a changed layout is a changed DDL and a
  stale stamp: that table alone is re-run. This matches today's per-table
  signature.
- **Gains:**
  - `CREATE OR REPLACE` takes SHARE ROW EXCLUSIVE. Today's
    `DROP TRIGGER IF EXISTS` + `CREATE` takes ACCESS EXCLUSIVE, which blocks
    the previous backend's *readers* during a hot swap. That conflict caused
    the 40P01 incident in build-1784288281433-w62dep.
  - The catalog-definition hash in each stamp. It catches a trigger replaced
    out of band, which today's presence-by-name check misses.
  - Ownership-by-function. Every trigger calling a feed function is owned, so
    a now-excluded or produced table's trigger is dropped. This replaces
    `planRebuild`'s `stale` map.
  - `live_state_trigger_state` and its bookkeeping (`forget`, the one-row
    shape migration) are deleted.
- **Must be pinned when built:** replacing a trigger in place when its
  REFERENCING clause changes (a table becoming routed gains
  `OLD TABLE AS old_rows` on UPDATE). This needs a DB test. If Postgres
  refuses it, that one transition drops and recreates the trigger.

## Why not in the schema layer's call

1. **Its inputs exist only in a booted graph.** The feed's set is computed
   from three things:
   - the live catalog after migrations;
   - the exclusions: rollups, `ExcludeFromChangeFeed` and change producers;
   - `routedTableRequirements()`, which comes from every registered and
     deferred-bound resource.

   `SchemaLayerInputs` is explicitly "REQUIRED arguments, never read from a
   registry". Its other caller, the `migration-applies-clean` dry run, builds
   them by importing main's server barrels (`declared-schema-inputs.ts`), and
   it boots no resource runtime. It could not derive the routed layouts.
   Worse, a sweep missing the feed's sets would drop the feed's triggers on
   every table of live main. The dry run rolls back, but it would take
   ACCESS EXCLUSIVE under a 1 s `lock_timeout`, so the check would flake or
   fail.
2. **Locking.** The feed's set spans every public table, about 200. Inside
   the schema layer, each changed table's lock is held until the whole layer
   commits: migrations, rollup reconcile, view rebuild. In practice,
   "changed" is most often one routed table whose layout moved. But when the
   template changes, it is every table: all writers on all tables are blocked
   for the layer's length. C12's fixed order turns a cycle with a writer that
   takes tables in another order into a *loud* failed boot. The feed's
   one-relation-per-transaction design makes that cycle *impossible*. That
   design is a fix for an incident that really happened, and it is the
   stronger rung, so don't trade it away.
3. **Timing gains nothing.** No one writes a new table's rows before the feed
   installs its trigger: the old backend does not know the table, and the new
   one is not serving until the barrier lifts. The feed's `onReadyBlocking`
   already runs after the database plugin's blocking hook commits, because
   `dependsOn` sequences the barrier. (The change-feed CLAUDE.md line saying
   "flat `Promise.all`" was stale; it is corrected with this doc.)

## The lock orders

The task's concern was that two installers with independent lock orders can
deadlock with each other. They cannot here:

- The feed's install runs after the schema layer committed, in the same boot.
- Each feed transaction holds at most ONE table lock plus its own state row.
  A transaction holding one lock is never a node of a wait cycle, whatever
  order anyone else uses.

A deferred contract's `completeDeferredContract` re-runs the schema layer
later, in the serving backend. It can overlap a later deploy's feed install
in time, but each feed transaction still holds one table. So the
"independent orders" never close a cycle. That property is what the per-table
commit mode must preserve when the feed moves onto the installer.

## The design

1. `db-triggers`:
   - **Per-table commit mode.** `installDbTriggers(db, sets, { commit:
     "per-table" })` is only valid on a non-transaction `db`. Order:
     - functions in one transaction first, committed before any trigger
       references them (the feed's prelude rule);
     - then one transaction per table in the fixed order: advisory lock,
       re-plan that table, apply, stamp;
     - drops of functions last.

     Asserted after, as today.
   - **Scoped sweep.** The schema layer's sweep must not treat a set another
     call installs as removed. The candidate design: a `DbTriggerSetOwner`
     contribution (`{ id }`) through which a plugin claims a set id it
     installs itself. The schema layer passes the claimed ids as "declared
     elsewhere", and the dry-run barrel walk reads the same contribution, so
     it is not a registry read. Pin it with a test: the schema layer's sweep
     leaves a claimed set's triggers alone.
2. `change-feed`:
   - **One set, `change-feed`:** both functions plus three triggers per
     triggered table, built at boot from the same inputs as today. It is
     installed with `{ commit: "per-table" }` after the prelude that creates
     the changelog and the end marker. Those stay hand-rolled; the end
     marker's catalog check already exists (`TXN_END_INSTALLED_SQL`).
   - **First boot adopts.** A table whose `live_state_trigger_state` row
     matches today's compiled DDL hash gets `legacyStamp: null` (restamp,
     COMMENT only). Without that, the switch would re-create every table's
     triggers in one deploy.
   - **Drop the state table later.** `live_state_trigger_state` stops being
     written. It is dropped once no supported database predates the switch;
     until then it stays denylisted.
   - **Unchanged:** A3 (`tgargs` read-back), A2′, coverage and the route
     assertions.

## As landed

Implemented in this same task:

- **`database/db-triggers`**:
  - `commit: "per-table"` (the pool only; a transaction throws);
  - `sweep.installedElsewhere`;
  - the `DbTriggerClaim` contribution.

  `SchemaLayerInputs.claimedTriggerSets` carries the claims. Boot reads them
  as contributions, and the dry run reads them from the barrels. Restamps now
  run inside each table's step, in the fixed order, in both modes.
- **`change-feed`**:
  - `rebuildTriggers` builds the `change-feed` set and installs it per table,
    after a prelude transaction that holds the changelog and the end marker;
  - `live_state_trigger_state` is read once for adoption, then dropped;
  - the server barrel contributes `DbTriggerClaim("change-feed")`.
- **Pinned by tests:**
  - an in-place replace that changes the REFERENCING clause works (same oid,
    new row version), in `triggers.test.ts`;
  - per-table commit, in `triggers.test.ts` and `db-triggers`'
    `install.test.ts`: the earlier table's triggers are visible from another
    session while a writer still holds the later one;
  - adoption (no re-create) and a mismatched-signature re-run;
  - the sweep sparing a claimed set and dropping it when unclaimed.
- **Known, accepted:** an older build whose schema layer still sweeps by
  schema alone drops the newer `change-feed` set on a fork of a newer
  database. This is the existing "older build on a newer fork" class: its own
  feed installer then rebuilds every table, and the next newer boot
  re-installs.
