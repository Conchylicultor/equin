import {
  setWatermarkSource,
  type ServerPluginDefinition,
} from "@plugins/framework/plugins/server-core/core";
import { db, DatabaseDriver } from "./internal/driver";
import { snapshotWatermark } from "./internal/snapshot-watermark";
import { loadKnownRelations } from "./internal/read-set-capture";
import {
  applySchemaLayer,
  MigrationSource,
  schemaGeneration,
} from "@plugins/database/plugins/migrations/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import {
  derivedInputs,
  runDeferredContract,
  setDeferredContract,
  takeDeferredContract,
} from "./internal/deferred-contract";
import { publishReconciledRollups } from "@plugins/database/plugins/derived-tables/server";

export {
  afterCommit,
  db,
  DatabaseDriver,
  isTransientDbError,
  type DatabaseDriverImpl,
  type Db,
  type ListenHandlers,
  type ListenSession,
} from "./internal/driver";
export { dbLog } from "./internal/db-log";
export {
  loadKnownRelations,
  quotedRelationsIn,
  readTag,
} from "./internal/read-set-capture";
export { currentTxId, type DbExecutor } from "./internal/current-tx-id";

export default {
  description:
    "Core database infrastructure: the app's `db` over the host's DatabaseDriver, DB readiness and the boot schema layer.",
  loadBearing: true,
  portable: true,
  // Blocking: every other plugin's `onReady` (and incoming requests) must see a
  // migrated, warm DB. Running this in the `onReadyBlocking` barrier makes that
  // guarantee real and lets the gateway hold the hot-swap until the schema layer
  // commits.
  async onReadyBlocking() {
    const driver = DatabaseDriver.get();
    await driver.ready();
    // The resource runtime's commit watermark is this database's snapshot xmin:
    // installed on every host with a database, before anything is served, so
    // every frame that fully reconciles a client carries one — whether or not
    // the host boots L2 (which only consumes it, as its persist floor).
    setWatermarkSource(() => snapshotWatermark(db));
    // This process's code, visible to every later deploy's deferred contract
    // for as long as it lives — taken before the schema layer, so no window
    // exists in which it is migrating yet unseen. Its generation is its latest
    // migration's.
    const migrations = MigrationSource.get().list();
    const latest = migrations.at(-1);
    if (latest !== undefined) {
      await driver.holdSchemaGeneration(schemaGeneration(latest));
    }
    // The boot schema layer, in ONE transaction: views out (only when a
    // migration is pending) → pending migrations, each phased schema migration
    // as expand → claimed data → contract (the LAST group's contract deferred
    // to `onReady`, below: it is what breaks the code still serving) → the
    // derived `updatedAt` triggers →
    // the trigger-maintained rollup tables (before the views: `attempts_v` LEFT
    // JOINs them) → the plain views. The previous backend, still serving during a
    // hot-swap, waits on its locks rather than reading missing views, and any
    // failure leaves the whole layer as it was. See
    // plugins/database/plugins/derived-views/CLAUDE.md and
    // research/2026-09-29-global-phased-migrations.md.
    //
    // The derived inputs are read HERE and passed in, never read inside the
    // layer: contributions are collected (and every `tables.ts` has run
    // `defineEntity`) before any `onReadyBlocking`, and the dry-run check that
    // runs the same layer from a process that never booted gathers them its
    // own way. The migration texts are the host's (`MigrationSource`).
    //
    // Boot DDL can wait minutes on the previous backend's locks during a
    // hot-swap, so the driver runs the layer under its boot DDL bound
    // (`bootDdl`). The wrap lives here, at the call site: the layer takes `db`
    // as a parameter precisely so it never imports this barrel (that would
    // cycle).
    const layer = await driver.bootDdl(
      () =>
        applySchemaLayer(db, migrations, derivedInputs(), {
          commit: true,
          deferContract: true,
        }),
      "boot: schema layer",
    );
    // What each rollup's reconcile healed, published only now that the layer
    // has COMMITTED (C13) — `reconciledRollups()` readers (live-state-snapshot's
    // A20 boot check) run after this barrier, so they see this boot's answer.
    publishReconciledRollups(layer.rollups);
    setDeferredContract(layer.deferredContract);
    // Last, because every relation a loader can read now exists. This is the
    // snapshot that tells an unquoted table name in a loader's raw SQL apart
    // from a CTE name or a subquery alias, so its read-set records the tables it
    // really depends on (`extractReadTablesFromSql`). One cheap catalog read,
    // not DDL — it waits on no lock, so it keeps the ordinary query deadline
    // rather than the widened boot one the schema layer above needs.
    await loadKnownRelations(db);
  },
  // Only a serving host runs the deferred contract (an exec child skips
  // `onReady`): after the barrier, so it never holds back readiness — the
  // gateway swaps to this backend, the previous one drains and exits, and
  // that exit is what the wait is for.
  onReady() {
    const file = takeDeferredContract();
    if (file === null) return;
    void runTracked("database:deferred-contract", () =>
      runDeferredContract(file),
    );
  },
} satisfies ServerPluginDefinition;
