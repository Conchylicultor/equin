import {
  getBootMode,
  setWatermarkSource,
  type ServerPluginDefinition,
} from "@plugins/framework/plugins/server-core/core";
import { db, DatabaseDriver } from "./internal/driver";
import { snapshotWatermark } from "./internal/snapshot-watermark";
import {
  setBootStamp,
  setSchemaChangedAtBoot,
  takeBootStamp,
} from "./internal/boot-schema";
import { loadKnownRelations } from "./internal/read-set-capture";
import {
  applySchemaLayer,
  MigrationSource,
  recordSchemaLayerStamp,
  schemaGeneration,
} from "@plugins/database/plugins/migrations/server";
import { awaitSchemaLayer } from "./internal/await-schema-layer";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import {
  derivedInputs,
  runDeferredContract,
  setDeferredContract,
  takeDeferredContract,
} from "./internal/deferred-contract";
import { publishReconciledRollups } from "@plugins/database/plugins/derived-tables/server";

// The snapshot watermark (xid8 text), for a caller that needs one outside a
// resource flight — change-feed's `feedCut`.
export { snapshotWatermark } from "./internal/snapshot-watermark";
// Whether this boot applied a migration or deferred a contract — read after
// the boot schema layer committed (the epoch handoff refuses across one).
export { schemaChangedAtBoot } from "./internal/boot-schema";
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
export { writeAtomically, type AtomicWrite } from "./internal/write-atomically";
export { trimToNewest } from "./internal/trim-to-newest";

export default {
  description:
    "Core database infrastructure: the app's `db` over the host's DatabaseDriver, DB readiness and the boot schema layer.",
  loadBearing: true,
  // Blocking: every other plugin's `onReady` (and incoming requests) must see a
  // migrated, warm DB. Running this in the `onReadyBlocking` barrier makes that
  // guarantee real and lets the gateway hold the hot-swap until the schema layer
  // commits.
  async onReadyBlocking({ step, schema }) {
    const driver = DatabaseDriver.get();
    // An `exec` child (a supervised job's body) runs one piece of work and
    // exits: it serves nobody, so it neither checks the background lane nor
    // warms a pool — a full pool per child only multiplies connections when
    // many boot at once.
    const serving = getBootMode() === "serve";
    // Two independent preludes, run together: the pool made ready, and this
    // process's schema generation held. Run one after the other they were a
    // fifth of the barrier's steady-state time (~100 ms + ~60 ms on main).
    const [, migrations] = await Promise.all([
      step("driver-ready", () => driver.ready({ serving })),
      // This process's code, visible to every later deploy's deferred
      // contract for as long as it lives — taken before the schema layer, so
      // no window exists in which it is migrating yet unseen. Its generation
      // is its latest migration's.
      step("schema-generation", async () => {
        const list = await MigrationSource.get().list();
        const latest = list.at(-1);
        if (latest !== undefined) {
          await driver.holdSchemaGeneration(schemaGeneration(latest));
        }
        return list;
      }),
    ]);
    // The resource runtime's commit watermark is this database's snapshot xmin:
    // installed on every host with a database, before anything is served, so
    // every frame that fully reconciles a client carries one — whether or not
    // the host boots L2 (which only consumes it, as its persist floor).
    setWatermarkSource(() => snapshotWatermark(db));
    // An `exec` child does not own the schema (`BootHookContext.schema`): the
    // serving backend set it up, and the child only checks that it did so for
    // THIS code — one read of the stamp the owner's layer commits, no lock
    // and no DDL. Until 2026-11-15 every child (~800 a day on main) ran the
    // whole layer itself: main's own boot waited 0.2–0.6 s behind any child
    // holding the schema-layer lock, and a child booted in the ~26 s between a
    // push advancing the checkout and the new backend booting applied the
    // push's migration itself, under the old backend, waiting up to 15 min on
    // its locks (task-1794734803-m7admg). A database not set up for this code
    // yet holds the child until its owner's layer commits (a NOTIFY, no
    // polling) — the deploy window — and refuses it with
    // `SchemaNotReadyError` past `SCHEMA_WAIT_MS`.
    if (schema.kind === "verifier") {
      await step("schema-verify", (inner) =>
        awaitSchemaLayer(migrations, derivedInputs(), inner),
      );
      // This process reconciled, applied and deferred nothing.
      publishReconciledRollups([]);
      setDeferredContract(null);
      setSchemaChangedAtBoot(false);
      await step("known-relations", () => loadKnownRelations(db));
      return;
    }
    const { owner } = schema;
    // The pool filled to its size while the schema layer runs: the layer holds
    // one connection, and the warm opens only the rest (`warmPool`), so the
    // two overlap instead of the layer waiting ~17 PgBouncer logins out. Both
    // are awaited before the barrier ends — the first wave still finds every
    // connection open.
    await Promise.all([
      serving ? step("warm-pool", () => driver.warmPool()) : null,
      (async () => {
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
        const layer = await step("schema-layer", (inner) =>
          driver.bootDdl(
            owner,
            () =>
              applySchemaLayer(db, migrations, derivedInputs(), {
                commit: true,
                owner,
                deferContract: true,
                step: inner,
              }),
            "boot: schema layer",
          ),
        );
        // What each rollup's reconcile healed, published only now that the layer
        // has COMMITTED (C13) — `reconciledRollups()` readers (live-state-snapshot's
        // A20 boot check) run after this barrier, so they see this boot's answer.
        publishReconciledRollups(layer.rollups);
        setDeferredContract(
          layer.deferredContract === null
            ? null
            : { owner, file: layer.deferredContract },
        );
        setBootStamp(owner, layer.stamp);
        setSchemaChangedAtBoot(
          layer.pending > 0 || layer.deferredContract !== null,
        );
        // Last, because every relation a loader can read now exists. This is the
        // snapshot that tells an unquoted table name in a loader's raw SQL apart
        // from a CTE name or a subquery alias, so its read-set records the tables it
        // really depends on (`extractReadTablesFromSql`). One cheap catalog read,
        // not DDL — it waits on no lock, so it keeps the ordinary query deadline
        // rather than the widened boot one the schema layer above needs.
        await step("known-relations", () => loadKnownRelations(db));
      })(),
    ]);
  },
  // Only a serving host runs the deferred contract (an exec child skips
  // `onReady`): after the barrier, so it never holds back readiness — the
  // gateway swaps to this backend, the previous one drains and exits, and
  // that exit is what the wait is for.
  async onReady() {
    // The stamp an `exec` child is admitted by, recorded only now: every
    // plugin's blocking hook has committed its boot DDL (the change feed's
    // triggers, the mirror's, the queue schema), so a child woken by its NOTIFY
    // finds the database whole — not only the layer.
    const stamped = takeBootStamp();
    if (stamped !== null) {
      await recordSchemaLayerStamp(db, stamped.owner, stamped.stamp);
    }
    const deferred = takeDeferredContract();
    if (deferred === null) return;
    void runTracked("database:deferred-contract", () =>
      runDeferredContract(deferred.owner, deferred.file),
    );
  },
} satisfies ServerPluginDefinition;
