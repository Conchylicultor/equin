import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  dropPendingPersists,
  persistedKeys,
  recomputeResource,
  scopedResourceTables,
  seedPersistedSnapshot,
  unboundedWindowKeys,
} from "@plugins/framework/plugins/server-core/core";
import {
  producedTableNames,
  relationBases,
} from "@plugins/database/plugins/change-feed/server";
import { db } from "@plugins/database/server";
import { ExcludeFromFork } from "@plugins/database/plugins/admin/server";
import { LIVE_STATE_SNAPSHOT_TABLE } from "@plugins/database/plugins/derived-views/core";
import { initSnapshotSubsystem } from "./internal/boot-init";
import { runBootCatchUp } from "./internal/boot-catch-up";
import { healedRollups } from "./internal/healed-rollups";
import { l2Expectation } from "./internal/expectation";
import { liveStateCompactJob } from "./internal/compact";
import { snapshotLog as log } from "./internal/log-sink";
import { assertNoPersistedProducedReader } from "./internal/produced-guard";
import { liveStateChangelogPruneJob } from "./internal/prune";
import { openProducedPersistReports } from "./internal/produced-reports";

// L2 persisted materialization. Owns the `live_state_snapshot` table (the durable
// materialized value), injects the runtime's persist hooks, runs the bounded
// cold-boot catch-up, and registers the changelog prune job. The `live_state_changelog`
// table (the transactional outbox) is owned by change-feed (it writes it from the
// trigger function). See
// research/2026-06-22-global-live-state-l2-persisted-materialization.md.
//
// `persist.ts` and `catch-up.ts` are db-PARAMETRIZED (no `@plugins/database/server`
// import) so a test can import them without reaching the namespace-bound worktree
// pool; the `db` singleton is bound HERE (a backend-only entry) and threaded into
// the hooks + catch-up below. The two public barrel exports keep their `(keys) => …`
// signature via `./internal/public-snapshots` (barrel-purity R3 forbids the
// singleton-binding wrappers living inline in this barrel).
export {
  readPersistedSnapshots,
  clearPersistedSnapshots,
} from "./internal/public-snapshots";

export default {
  description:
    "L2 persisted live-state materialization: durable snapshot + xmin watermark for instant cold boot, served only from a usable row (a key the runtime persists now, under its current definition, from a current writer). Two persist modes (a FULL recompute replaces; a persisted alias's trailing window lowers the floor), an hourly compact job, and a boot catch-up that seeds each persisted alias from its row and replays the changelog by scope — or, when history was pruned past the floor or a rollup was healed, recomputes every persisted key.",
  loadBearing: false,
  contributions: [
    // The snapshot is a cold-boot ACCELERATOR, not a correctness prerequisite —
    // `initSnapshotSubsystem` degrades to a full recompute when it is absent, so
    // a fork loses startup latency and nothing else.
    //
    // It must not be inherited, because a persisted value is computed FROM other
    // tables and the fork empties several of them (notifications, mail, the
    // observability set). Keeping the snapshot while emptying its sources would
    // make a fresh worktree serve a value that disagrees with the rows behind it
    // — and for a boot-critical resource that stale value is what the very first
    // paint renders. Emptying both makes that mismatch unrepresentable.
    //
    // A table name string rather than a table object: this table is created with
    // `CREATE TABLE IF NOT EXISTS` (see derived-views/core's imperative-tables),
    // not by a drizzle migration, so there is no table object to pass.
    ExcludeFromFork({
      table: LIVE_STATE_SNAPSHOT_TABLE,
      reason:
        "Cold-boot accelerator computed from tables the fork empties; an inherited value would disagree with the rows behind it on first paint.",
    }),
  ],
  register: [liveStateChangelogPruneJob, liveStateCompactJob],
  // Create the snapshot table and INJECT the persist hooks into the resource
  // runtime here — before the ready barrier flips and before any flush could try
  // to persist. The `onReadyBlocking` phase is graph-driven by `dependsOn`, and
  // this plugin imports `db` (→ `dependsOn` edge to `database`), so this hook runs
  // AFTER `database`'s `onReadyBlocking` (which awaits `awaitDbReady` + runs the
  // migrations) — the DB is live and migrated by the time we read/write the
  // snapshot. The changelog table is created by change-feed's own onReadyBlocking
  // (rebuildTriggers), inside its trigger-rebuild txn; we never touch it here.
  //
  // Snapshot init is GRACEFUL-DEGRADATION work, not a barrier prerequisite: a
  // failure degrades cold-boot (full recompute in onReady) rather than crashing.
  // Because `onReadyBlocking` throws are fatal by contract, that degradation is
  // handled EXPLICITLY inside `initSnapshotSubsystem` (catch + log + continue) — it
  // never throws, so a snapshot-table failure can't abort boot. See boot-init.ts.
  async onReadyBlocking() {
    // A20: the boot schema layer — and with it every rollup's reconcile — has
    // committed before L2 reads anything (`database` is a dependsOn edge, so
    // its onReadyBlocking ran first); `healedRollups()` throws otherwise, a
    // boot-order bug. A heal clears every persisted row here, before
    // readiness flips.
    const healed = healedRollups();
    // The tables an in-process change producer feeds (contributions are
    // collected before this barrier): volatile, so never L2-persisted (A6).
    const produced = producedTableNames();
    // D28: the guard and the sweep judge a read-set through the relation bases
    // change-feed set in its `onReadyBlocking` (a dependsOn parent — it ran
    // first); a read before that throws. Probed HERE, outside the graceful
    // degradation below (whose catch would turn the throw into a disabled L2),
    // so a boot-order bug blocks boot, like A20 above.
    relationBases(LIVE_STATE_SNAPSHOT_TABLE);
    await initSnapshotSubsystem(db, produced, relationBases, healed);
    // A6 (boot, static evidence): a key the runtime persists whose routes or
    // identity table name a produced table blocks boot. Outside the graceful
    // degradation above on purpose — it is a declaration bug, not a snapshot
    // failure. `persistedKeys()` is the runtime's own gate, which reads the
    // hooks just installed (a degraded init persists nothing, so finds none).
    assertNoPersistedProducedReader(
      persistedKeys(),
      scopedResourceTables(),
      produced,
    );
  },
  // Boot init + bounded catch-up, after the barrier (alongside change-feed's
  // listener, which also starts in onReady) — `runBootCatchUp` holds the order
  // (usable read, probe, backstop-first, then recompute / seed / replay).
  async onReady() {
    const exp = l2Expectation();
    // A degraded init installed no hooks, so nothing is persisted — and there
    // is nothing to seed or catch up (catch-up exists for persisted values).
    if (exp.persisted.length === 0) return;
    // ORDERING INVARIANT (gap-free boot): the replay MUST run AFTER the
    // change-feed listener's LISTEN is established, so any commit landing after
    // its `SELECT` produces a NOTIFY on the live path (double-handling is
    // harmless — catch-up is an idempotent recompute+diff). This holds
    // structurally: live-state-snapshot statically imports change-feed
    // (`routeChange`, table constants) → a dependsOn edge → its `onReady` fires
    // after change-feed's `onReady` (which calls `startListener()`). Do NOT
    // remove that import edge without re-establishing the ordering another way.
    await runBootCatchUp(db, exp, {
      healedRollups: healedRollups(),
      aliasKeys: unboundedWindowKeys(),
      recompute: recomputeResource,
      seed: (key, value, base) => seedPersistedSnapshot(key, "{}", value, base),
    });
  },
  // Drop the armed trailing floor persists: their changes are in the
  // changelog and each row's floor still predates them, so the next boot's
  // catch-up replays them. Writing them here would race the pool's teardown.
  onShutdown() {
    const dropped = dropPendingPersists();
    if (dropped > 0) {
      log.publish(
        `[live-state-snapshot] shutdown: dropped ${dropped} pending floor persist(s) — catch-up replays them`,
      );
    }
  },
  // The A6 reports (boot sweep, runtime refusal) are held until every plugin's
  // `onReady` ran: the reports plugin installs server-core's error reporter in
  // its own, and a report filed before that would be dropped.
  onAllReady() {
    openProducedPersistReports();
  },
} satisfies ServerPluginDefinition;
