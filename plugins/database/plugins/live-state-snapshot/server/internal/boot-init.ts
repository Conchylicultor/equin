import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  setLiveStateSnapshotHooks,
  seedRouteDrift,
  unboundedWindowKeys,
  validatePersistedValue,
} from "@plugins/framework/plugins/server-core/core";
import { ensureSnapshotTable } from "./tables-ddl";
import {
  shouldPersist,
  captureWatermark,
  persistSnapshot,
  readPersistedReadSets,
  sweepUnusableSnapshots,
  clearPersistedSnapshots,
} from "./persist";
import { l2Expectation } from "./expectation";
import {
  clearHealedSnapshots,
  clearInvalidAliasSnapshots,
} from "./boot-catch-up";
import {
  createProducedPersistGuard,
  sweepProducedSnapshots,
  type RelationBases,
} from "./produced-guard";
import { snapshotLog as log } from "./log-sink";
import { producedPersistReports } from "./produced-reports";

// Install the L2 snapshot subsystem during the `onReadyBlocking` barrier: create
// the snapshot table, inject the persist hooks into the resource runtime, and seed
// the drift guard from the durable `tables_read` column — all before the
// readiness flag flips (so a persist can never fire with the hooks unset, and
// catch-up's first replay reaches a drifted read).
//
// This is a GRACEFUL-DEGRADATION hook. The snapshot layer is a cold-boot
// *accelerator*, not a correctness prerequisite: if it can't initialize, the
// resources simply full-recompute in `onReady` (correct, just a colder boot). But
// `onReadyBlocking` throws are fatal by contract (a barrier that doesn't complete
// must abort boot — see server-core `ServerPluginDefinition.onReadyBlocking`), so
// the degradation MUST be made explicit right here rather than leaked to the
// framework: catch, log loudly, and continue with the hooks simply not installed.
// Letting this throw escape would crash the backend over an optional optimization.
//
// `produced` is the set of tables fed by an in-process change producer (A6, see
// ./produced-guard): a persisted row reading one is swept here, and a persist
// whose read-set reaches one is refused for the life of the process. Both judge
// a read-set through `relationBases` (D28 — change-feed's boot graph, set in its
// own `onReadyBlocking`, which runs before this plugin's): a view or rollup over
// a produced table reaches it.
//
// `healedRollups` are the rollups this boot's committed reconcile healed (A20):
// every persisted row is cleared before readiness flips, so boot-snapshot can
// never serve a value computed from a drifted rollup as a first paint.
//
// A30: every persisted alias row whose value does not parse as its entry's
// payload is cleared here too, before readiness flips, for the same reason.
export async function initSnapshotSubsystem(
  db: NodePgDatabase,
  produced: ReadonlySet<string>,
  relationBases: RelationBases,
  healedRollups: readonly string[],
): Promise<void> {
  try {
    await ensureSnapshotTable(db);
    // A6 (runtime): a persist whose guard tables name a produced table is
    // refused, and its key never writes a row again in this process. The
    // persist GATE below stays the plain `shouldPersist` — the runtime assumes
    // it fixed for the process, so the guard drops the write, never the key's
    // persistedness. Both modes are judged on `meta.guardTables` (C21): a
    // replace's run read-set, a floor persist's route tables / read-set union —
    // never an empty list, so a floor persist's first INSERT is guarded too.
    const guard = createProducedPersistGuard({
      produced,
      relationBases,
      onRefused: async (key, tables) => {
        // Never served again: drop the row a previous persist left.
        await clearPersistedSnapshots(db, [key]);
        reportProducedPersist(
          `refused to persist "${key}": its read-set reaches produced table(s) ${tables.join(", ")} — the key writes no row again in this process`,
        );
      },
    });
    // Installed BEFORE the sweep: the runtime's `persistedKeys()` — the sweep's
    // keep set — reads `shouldPersist` through these hooks. No flush runs
    // before the ready barrier, so nothing persists in between; a failure
    // below uninstalls them (the catch).
    setLiveStateSnapshotHooks({
      shouldPersist,
      captureWatermark: () => captureWatermark(db),
      persistSnapshot: async (key, paramsKey, value, watermark, meta) => {
        if (await guard.refuses(key, meta.guardTables)) return;
        await persistSnapshot(db, key, paramsKey, value, watermark, meta);
      },
    });
    const exp = l2Expectation();
    // Sweep every row that is not USABLE before seeding the route drift bases or
    // serving a boot snapshot: a key no longer persisted (migrated to a bounded
    // window / point, external, its `preload` dropped), a row another
    // definition wrote, or one an older writer left (C22). Every read refuses
    // such a row anyway (the usable-row predicate); this is the cleanup, keyed
    // by the runtime's own persist gate (`persistedKeys()`, C23) — never a
    // hardcoded name. One bounded DELETE; a no-op when clean.
    const swept = await sweepUnusableSnapshots(db, exp);
    if (swept > 0) {
      log.publish(
        `swept ${swept} unusable snapshot row(s) (non-persisted key, other definition, or an older writer)`,
        "stdout",
      );
    }
    // A6 (stale rows): a persisted value over a produced table may predate the
    // code that stopped persisting it — delete it (before the route drift seed
    // below can index it), and say so once.
    const sweptProduced = await sweepProducedSnapshots(
      db,
      produced,
      relationBases,
    );
    if (sweptProduced.length > 0) {
      reportProducedPersist(
        `deleted ${sweptProduced.length} stale L2 snapshot row(s) whose read-set reaches a produced table: ${sweptProduced
          .map((r) => `${r.resource_key} (${r.produced.join(", ")})`)
          .join("; ")}`,
      );
    }
    const cleared = await clearHealedSnapshots(db, exp, healedRollups);
    if (cleared > 0) {
      log.publish(
        `cleared ${cleared} persisted snapshot row(s): the boot reconcile healed rollup(s) ${healedRollups.join(", ")}`,
        "stderr",
      );
    }
    // A30 (before readiness): an alias row whose value its payload schema
    // rejects is cleared now, not at `onReady`'s seed — boot-snapshot's
    // persisted fast path is open in between and would serve it, and the
    // client's hydrate would reject it on every page load.
    const invalid = await clearInvalidAliasSnapshots(db, exp, {
      aliasKeys: unboundedWindowKeys(),
      validate: validatePersistedValue,
    });
    for (const { key, error } of invalid) {
      log.publish(
        `[live-state-snapshot] WARNING: the persisted value of "${key}" does not parse as its payload (${error}) — cleared its row; onReady recomputes it`,
        "stderr",
      );
    }
    const persistedReadSets = await readPersistedReadSets(db, exp);
    // D7: a persisted entry's drift survives the restart — each `tables_read`
    // relation its declaration does not cover (the drift guard's own
    // predicate: a declared rollup or view is covered) fails open again, so
    // catch-up's replay and every later write to it reach the entry. Not an
    // error: the row may predate a declaration change (or carry an edge the
    // code no longer reads), so the runtime reports a drift only when a load
    // reads the relation again — this line just says what was routed.
    const drifted = seedRouteDrift(
      [...persistedReadSets].map(([key, tablesRead]) => ({ key, tablesRead })),
    );
    for (const { key, tables } of drifted) {
      log.publish(
        `[live-state-snapshot] "${key}" last read ${tables.join(", ")} outside its declared reads — routed FULL on them until its next load: still read → reported as drift, else un-routed`,
        "stdout",
      );
    }
  } catch (err) {
    // Uninstalled: a half-initialized L2 persists nothing, exactly as if the
    // hooks had never been installed.
    setLiveStateSnapshotHooks(null);
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    // Loud but non-fatal: cold-boot acceleration is off for this boot; correctness
    // is preserved by the full recompute in onReady. console.error surfaces it in
    // the per-worktree backend boot log; the persisted channel surfaces it in the
    // Debug → Logs pane.
    console.error(
      `[live-state-snapshot] L2 snapshot init failed; degrading to cold recompute`,
      msg,
    );
    log.publish(
      `L2 snapshot subsystem init failed; degrading to cold recompute (no persisted snapshots this boot): ${msg}`,
      "stderr",
    );
  }
}

// One A6 report: the boot sweep and the runtime refusal each file at most one
// per key. Logged at once; filed through a HELD sink, because both can fire
// before the reports plugin installs server-core's error reporter (the sweep
// runs in `onReadyBlocking`, a refusal can follow `onReady`'s forced
// recomputes) — `reportServerError` itself drops a report with no reporter.
function reportProducedPersist(message: string): void {
  log.publish(`[live-state-snapshot] A6: ${message}`, "stderr");
  producedPersistReports.emit(`[live-state-snapshot] A6: ${message}`);
}
