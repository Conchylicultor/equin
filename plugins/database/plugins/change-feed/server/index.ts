import {
  scopedResourceTables,
  unfedResourceTables,
  relationResourceReads,
  unroutedResourceKeys,
  routedTableRequirements,
  type ServerPluginDefinition,
} from "@plugins/framework/plugins/server-core/core";
import {
  DatabaseDriver,
  db,
  loadKnownRelations,
} from "@plugins/database/server";
import {
  feedExemptTables,
  rollupSources,
} from "@plugins/database/plugins/derived-tables/server";
import { excludedTableNames } from "./internal/exclusion";
import { installFeed } from "./internal/install-feed";
import {
  dropPendingProducerChanges,
  producedTableNames,
} from "./internal/producer";
import { startListener, stopListener } from "./internal/listener";
import { buildViewDeps } from "./internal/view-deps";
import { installRelationGraph } from "./internal/relation-bases";

export { rebuildTriggers, getCoveredTables } from "./internal/triggers";
// Opt a high-churn observability table out of the L4 change-feed (see
// ./internal/exclusion for the trade this makes).
export { ExcludeFromChangeFeed } from "./internal/exclusion";
export { parseLiveStatePayload, readLayout } from "./internal/parse-payload";
export type { DbChange } from "./internal/parse-payload";
// The single source of change routing — reused by the L2 cold-boot catch-up
// driver (live-state-snapshot) so replay can never drift from the live LISTEN
// path. See research/2026-06-22-global-live-state-l2-persisted-materialization.md.
export { routeChange } from "./internal/route-change";
// The base tables a read of a relation depends on (a view and a rollup expand
// to the tables that feed them), under the graph read at boot — live-state-
// snapshot's A6 (D28) judges a persisted read-set through it. Throws if read
// before this plugin's `onReadyBlocking` set it.
export { relationBases } from "./internal/relation-bases";
// What `routeChange` takes: every change states its source (the feed, or an
// in-process change producer).
export type {
  FeedChange,
  ProducerChange,
  RoutedChange,
} from "./internal/route-change";
// The in-process change source of a table the feed installs no trigger on: a
// producer owns its table's write verb (`mutate`) and routes the rows each
// statement returned. `changeProducerFor` lets a generic writer (retention) find
// a table's producer; `producedTableNames` is the mounted set (A6 in
// live-state-snapshot reads it).
export {
  changeProducerFor,
  defineChangeProducer,
  producedTableNames,
  PRODUCER_IDS_CAP,
} from "./internal/producer";
export type {
  ChangeProducer,
  ChangeProducerContribution,
  ChangeProducerOptions,
  ChangeProducerSpec,
  ProducerBuilder,
  ProducerExecutor,
  WriteLatency,
} from "./internal/producer";

export default {
  description:
    "L4 DB change-feed: STATEMENT-level Postgres triggers that pg_notify on every commit, plus a LISTEN consumer routing each change through the live-state recompute cascade — making missed invalidations structurally impossible and out-of-process writes visible. A table written only by this backend at high rate may instead declare an in-process change producer (defineChangeProducer): no trigger, its `mutate` owns the write and routes the returned ids, coalesced at the source and volatile.",
  // Runs on every host with a database: the desktop's backend, and a browser
  // host's worker on PGlite. The one part that differs per host — opening the
  // LISTEN session — is the host's `DatabaseDriver.listen`; the changelog's
  // fork exclusion (forking is the desktop's) is `./machine`.
  portable: true,
  // Triggers are deterministic, data-less DDL rebuilt from the live schema on
  // every boot (like derived-views), NOT a migration. This runs in the blocking
  // barrier so the feed's triggers exist before any traffic — and the listener
  // (started in onReady, after the barrier) is guaranteed to find them.
  async onReadyBlocking() {
    // The contributed exclusions and producers, read once here: contributions
    // were collected before this barrier. The routed tables' trigger layouts
    // and the resource tables are derived from every registered route —
    // resources register at module eval and deferred ones bind right after
    // contributions are collected, both before this barrier.
    //
    // The relation graph — each view's direct reads, each rollup's sources —
    // is read here too: the database plugin's `onReadyBlocking` (a dependsOn
    // parent) committed the derived views and rollups before this one starts.
    const relations = {
      views: await buildViewDeps(db),
      rollups: rollupSources(),
    };
    const inputs = {
      relations,
      exclusions: {
        feedExempt: feedExemptTables(),
        optedOut: excludedTableNames(),
        produced: producedTableNames(),
      },
      layouts: routedTableRequirements(),
      scoped: scopedResourceTables(),
      unfed: unfedResourceTables(),
      relationReads: relationResourceReads(),
      unrouted: unroutedResourceKeys(),
    };
    // The trigger rebuild and the boot invariants it is checked against (A1′,
    // A2′, A3, A3p, D35 — see ./internal/install-feed). Per-table DROP+CREATE
    // TRIGGER can wait on the previous backend's readers during a hot-swap:
    // the driver's boot DDL bound widens the query deadline for the install's
    // own queries (the desktop's; PGlite adds none).
    await DatabaseDriver.get().bootDdl(
      () => installFeed(db, inputs),
      "boot: change-feed trigger rebuild",
    );
    // `installFeed` above creates `live_state_changelog`, which did not exist
    // yet when the database plugin took its own snapshot of the public relations.
    // Take it again so a loader naming the changelog unquoted is recognised too.
    // Idempotent, and it replaces the set wholesale.
    //
    // Here, in the blocking barrier, rather than in `onReady` below: `onReady`
    // runs after the barrier lifts, when the gateway may already be routing
    // traffic, and a loader running in that window would capture nothing.
    await loadKnownRelations(db);
    // Relation bases (C30, D34): a reach plan's relation reads are indexed
    // under them (server-core's `setRelationBases` → `indexRelationReads`), so
    // a reader of `tasks_v` is reached by a write to `conversations` (through
    // the `attempt_conv_agg` rollup), and the drift guard fails open through
    // them. Set here, in the barrier, so
    // live-state-snapshot's A6 guard, boot sweep and drift seed (a dependsOn
    // child, whose `onReadyBlocking` runs after this one) and the L2 catch-up
    // read them; server-core's holder throws if anything reads them earlier.
    installRelationGraph(relations);
  },
  // The LISTEN consumer is a background watcher, so it starts after the ready
  // barrier (same phase as git-watcher's startGitWatcher). Every serving host
  // runs `onReady` (the desktop's `serve`, a browser host after its seed); an
  // `exec` child does not, so it opens no LISTEN.
  onReady() {
    startListener();
  },
  async onShutdown() {
    // A producer's pending window must not fire into a runtime tearing down.
    dropPendingProducerChanges();
    await stopListener();
  },
} satisfies ServerPluginDefinition;
