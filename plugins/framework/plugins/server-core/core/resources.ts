import { createResourceRuntime } from "@plugins/framework/plugins/resource-runtime/core";
import type {
  Resource as RtResource,
  ExternalResource as RtExternalResource,
  ResourceDefinition as RtDef,
  ResourceContract as RtContract,
  ServerResourceOptions as RtServerOpts,
  KeyedServerResourceOptions as RtKeyedServerOpts,
  ResourceMode as RtMode,
  ResourceParams as RtParams,
  DependsOnEntry as RtDep,
  TableChange as RtTableChange,
  ChangeSource as RtChangeSource,
  TableLayoutRequirement as RtTableLayoutRequirement,
  PersistMeta as RtPersistMeta,
  PersistedBase as RtPersistedBase,
  SeedOutcome as RtSeedOutcome,
  PersistedValueCheck as RtPersistedValueCheck,
  ResourceDelivery as RtDelivery,
} from "@plugins/framework/plugins/resource-runtime/core";
import {
  recordEntrySpan,
  recordSpan,
  chargeWait,
  getRuntimeProfile,
  registerGateGauge,
} from "./profiler-hooks";
import {
  bumpReadSetVersion,
  getLastLoaderReadSet,
  readSetOf,
  readSetVersion,
} from "./read-set";
import { defineServerContribution } from "./contributions";
import { reportServerError, type ServerErrorReport } from "./error-reporter";

// Live-state primitive — per-worktree server side. The runtime itself lives in
// @plugins/framework/plugins/resource-runtime/core (shared with central-core);
// this file is the stable server-core facade: it instantiates the runtime with
// the server's hooks (profiler spans, error reporting, declare-based debug
// owners) and re-presents the runtime types as server-core's public surface.
// See research/2026-04-15-global-sse-lifecycle-mental-model-v3.md and
// research/2026-06-08-global-unify-live-state-resource-runtime.md.
//
// A plugin calls defineResource({key, loader, schema, mode}). The server exposes:
//   GET /api/resources/:key                      — HTTP fallback
//   WS  /ws/notifications                        — single push channel
// and broadcasts updates when the plugin calls resource.notify().

// Re-present the runtime types as server-core's stable public surface (type
// aliases are permitted in barrels; keeps the ~42 consumers untouched).
export type ResourceParams = RtParams;
export type ResourceMode = RtMode;
export type Resource<T, P extends ResourceParams = ResourceParams> = RtResource<
  T,
  P
>;
export type ExternalResource<
  T,
  P extends ResourceParams = ResourceParams,
> = RtExternalResource<T, P>;
export type ResourceDefinition<
  T,
  P extends ResourceParams = ResourceParams,
> = RtDef<T, P>;
// Two-arg `defineResource(contract, serverOpts)` surface: `contract` is the
// browser-safe shared descriptor (key/schema/keyed), `serverOpts` the DB half.
// Lets a keyed resource declare its keyed-ness in ONE place — the client
// descriptor — instead of restating `mode`/`keyOf` on the server and drifting.
// The DB half comes in two variants: `ServerResourceOptions` for a non-keyed
// contract (`mode: "push" | "invalidate"` required — there is no default) and
// `KeyedServerResourceOptions` for a keyed one (no `mode`: it is the contract's).
export type ResourceContract<
  T,
  P extends ResourceParams = ResourceParams,
> = RtContract<T, P>;
export type ServerResourceOptions<
  T,
  P extends ResourceParams = ResourceParams,
> = RtServerOpts<T, P>;
export type KeyedServerResourceOptions<
  T,
  P extends ResourceParams = ResourceParams,
> = RtKeyedServerOpts<T, P>;
export type DependsOnEntry<P extends ResourceParams = ResourceParams> =
  RtDep<P>;
// What a change producer hands `routeTableChange` (see resource-runtime/core's
// `routing.ts`): the DB change-feed builds one per NOTIFY, catch-up row and sweep.
export type TableChange = RtTableChange;
// Which producer made a `TableChange`: the DB change feed, or an in-process
// change producer (change-feed's `defineChangeProducer`).
export type ChangeSource = RtChangeSource;
// One routed table's trigger layout (`routedTableRequirements`).
export type TableLayoutRequirement = RtTableLayoutRequirement;
/** How one L2 persist writes its row (replace / floor) — see `LiveStateSnapshotHooks`. */
export type PersistMeta = RtPersistMeta;
/** The L2 row a boot seed restores (`seedPersistedSnapshot`). */
export type PersistedBase = RtPersistedBase;
/** What a boot seed did with an L2 value (`seedPersistedSnapshot`; A30 refuses one that does not parse). */
export type SeedOutcome = RtSeedOutcome;
/** Whether an L2 value parses as its alias's payload (`validatePersistedValue`, A30). */
export type PersistedValueCheck = RtPersistedValueCheck;

// Resource.Declare stays here — its ~37 contributors import it from server-core.
// `preload` (`"boot"` / `"boot-and-keep"`) is a param-less resource's opt-in to
// being warmed server-side and hydrated client-side before first paint. It is
// declared ONCE, on the shared client `ResourceDescriptor`
// (`@plugins/primitives/plugins/live-state/core`), and threaded through
// `defineResource`/`defineExternalResource` onto the resource object — so
// `Declare` DERIVES it from the resource here rather than restating it. Consumers
// read the set generically (`Resource.Declare.getContributions().filter(c => c.preload !== undefined)`),
// never by naming a specific resource. See research/2026-06-14-global-cold-load-instant-boot.md
// and research/2026-09-25-global-live-values.md.
//
// Declare takes ONE arg — the resource — and its token projects the payload
// explicitly from the resource's own `key`/`mode`/`preload` (a `Resource`
// carries its loader too, which must not ride the contribution). There is no
// opts param, so a stale `Declare(r, { preload: "boot" })` is a compile error
// that forces the flag onto the descriptor factory call.
//
// `preloadTuples` is the one server-only preload field: a PARAMETERIZED
// preloaded value has no default tuple, so its served half names AND loads the
// tuples the boot snapshot ships (network/live's `serveValue`, which requires an
// enumeration for such a value and builds this from it). Present ⇒ an
// enumerated preload: the boot snapshot ships every tuple it returns, and L2
// neither persists nor force-recomputes the key (its rows are one param-less
// tuple per key). Each tuple settles on its own — a failed one is omitted and
// reported, never the whole key.
type ResourceDeclarePayload = {
  key: string;
  mode: ResourceMode;
  preload?: "boot" | "boot-and-keep";
  preloadTuples?: () => Promise<
    (
      | { params: ResourceParams; ok: true; value: unknown }
      | { params: ResourceParams; ok: false; error: unknown }
    )[]
  >;
};

export const Resource = {
  Declare: defineServerContribution<
    ResourceDeclarePayload,
    ResourceDeclarePayload
  >("resource.declare", {
    docLabel: (r) => r.key,
    project: (resource) => ({
      key: resource.key,
      mode: resource.mode,
      preload: resource.preload,
      ...(resource.preloadTuples !== undefined
        ? { preloadTuples: resource.preloadTuples }
        : {}),
    }),
  }),
};

// Relation bases (C30): the base tables a read of a relation depends on — a
// view's tables, transitively, with each rollup replaced by its sources. The
// legacy router indexes every read-set relation under its bases, so a reader of
// `tasks_v` is reached by a `conversations` write. The graph lives in the
// database layer (views, rollups), which server-core/core must NOT statically
// import (derived-views/server already imports this barrel — a cycle), so
// change-feed injects it at boot (`setRelationBases`, in its `onReadyBlocking`,
// D34). Read before that, the holder THROWS: a router or guard running before
// the graph is set would silently miss every view reader, so a wrong boot order
// is loud. Setting it bumps the read-set version (D33), so the router's
// memoized table → resource inversion is rebuilt through the new bases.
let relationBasesHolder: ((relation: string) => readonly string[]) | null =
  null;
export function setRelationBases(
  fn: (relation: string) => readonly string[],
): void {
  relationBasesHolder = fn;
  bumpReadSetVersion();
}
/** Back to "not set" (test support: a suite that set bases must not leak them into the next). */
export function clearRelationBases(): void {
  relationBasesHolder = null;
  bumpReadSetVersion();
}
function relationBasesOf(relation: string): readonly string[] {
  if (relationBasesHolder === null) {
    throw new Error(
      `[resources] relation bases read before change-feed set them (setRelationBases) — relation "${relation}"`,
    );
  }
  return relationBasesHolder(relation);
}

// L2 persisted-materialization hooks — injected at boot by the
// `live-state-snapshot` feature plugin (the same byte-for-byte pattern as
// `setRelationBases`). server-core/core MUST NOT statically import that plugin
// (it imports `@plugins/database/server` + this barrel — a static import here
// would cycle). So the plugin calls `setLiveStateSnapshotHooks` once at boot and
// the runtime closures below read the CURRENT holders at call time. Before
// injection (and on central, which never installs them) every hook is the inert
// default: `shouldPersist` returns false → no resource is persisted, and the
// capture/persist hooks are never reached. The runtime is constructed before the
// setter runs, which is harmless because the closures dereference the holder
// lazily. See research/2026-06-22-global-live-state-l2-persisted-materialization.md.
export interface LiveStateSnapshotHooks {
  shouldPersist: (key: string) => boolean;
  captureWatermark: () => Promise<string>;
  /** See `ResourceRuntimeOptions.persistSnapshot`: `meta.mode` is replace or floor. */
  persistSnapshot: (
    key: string,
    paramsKey: string,
    value: unknown,
    watermark: string,
    meta: PersistMeta,
  ) => Promise<void>;
}
let liveStateSnapshotHooks: LiveStateSnapshotHooks | null = null;
/**
 * Install the L2 hooks — or, with `null`, uninstall them: an init that failed
 * after installing them (they must be installed before `persistedKeys()` can
 * answer) degrades to "nothing persisted" exactly as if it never had.
 */
export function setLiveStateSnapshotHooks(
  hooks: LiveStateSnapshotHooks | null,
): void {
  liveStateSnapshotHooks = hooks;
}

// The build graph this backend serves, for judging a live-resource contract
// mismatch (`ResourceRuntimeOptions.serverBuildGraph`): a tab whose build
// differs is out of date (skew — warned, not reported); one whose build matches
// has a real bug (reported). Boot-injected by `build/server-build-id`, which
// owns reading the served dist (server-core must not import build — the same
// boot-injection pattern as `setLiveStateSnapshotHooks`). The fn must return
// the graph memoized at BOOT, not a fresh read. Before injection, and on
// central, the graph is unknown (`null`) → every verdict `unknown` → reported.
let clientBuildIdentity: () => string | null = () => null;
export function setClientBuildIdentity(fn: () => string | null): void {
  clientBuildIdentity = fn;
}

function errorReport(context: string, err: unknown): ServerErrorReport {
  const e = err instanceof Error ? err : new Error(String(err));
  return {
    message: `[resources] ${context}: ${e.message}`,
    stack: e.stack ?? null,
    errorType: e.constructor.name !== "Error" ? e.constructor.name : null,
  };
}

// Push-outcome observer registry (the `onSlowSpan` shape): lets other plugins
// subscribe to per-push outcomes (was the push a real content change, or a wasted
// no-op?) WITHOUT server-core importing them. The runtime emits `onPush` once per
// keyed push to >=1 subscriber; we fan it out to every registered observer. A
// debug plugin registers at boot via `onResourcePush` from this barrel.
export type ResourcePushObserver = (
  key: string,
  info: { subscribers: number; changed: boolean },
) => void;
const pushObservers = new Set<ResourcePushObserver>();
export function onResourcePush(cb: ResourcePushObserver): () => void {
  pushObservers.add(cb);
  return () => pushObservers.delete(cb);
}

// Delivery-latency observer registry — the same shape as `onResourcePush` above.
// The runtime reports EVERY delivery to >=1 subscriber (first notify → ws.send);
// the profiler keeps only an aggregate and the slow-op funnel keeps only the ones
// over its threshold, so a plugin that wants the whole distribution (p50/p95)
// registers here. Runs on the flush path: an observer must be O(1) and never throw.
// `info` is the runtime's `ResourceDelivery` (latency, fan-out, frame size, and the
// change's wall clock when the frame carried `timing`).
export type ResourceDeliveryObserver = (key: string, info: RtDelivery) => void;
const deliveryObservers = new Set<ResourceDeliveryObserver>();
export function onResourceDelivery(cb: ResourceDeliveryObserver): () => void {
  deliveryObservers.add(cb);
  return () => deliveryObservers.delete(cb);
}

// `wrapLoad` only establishes the profiler entry span + ambient context for the
// loader body. Concurrency is NOT bounded here: the scarce resource is DB
// connections, not loader bodies, so the gate lives at the one place those are
// consumed — the wrapped `pool.query` in `database/server/internal/client.ts`,
// which caps loader-kind queries and reserves capacity for interactive work. An
// in-memory loader that issues no query therefore never waits. See
// research/2026-06-19-global-live-state-unified-read-path-v2.md (Task 2).
const runtime = createResourceRuntime({
  // Native wyhash on the keyed-delta hot path (the runtime's portable default
  // is plain-JS `hash64`); the length fold kills every different-length
  // collision.
  snapHash: (json) => Bun.hash.wyhash(json) ^ BigInt(json.length),
  // The label stays the resource key (one slow-op row per resource, and the key
  // the loader→tables read-set index is built on); WHICH params ran rides as the
  // span's variant, and a scoped refill carries how many ids it read.
  wrapLoad: (key, info, fn) =>
    recordEntrySpan("loader", key, fn, {
      variant: info.variant,
      measures:
        info.scopedIds !== undefined ? { ids: info.scopedIds } : undefined,
    }),
  // The live-state HTTP fallback as an `http` entry, 304s included. It is a raw
  // route (not `implement()`), so nothing else opens one. The label names the
  // resolved key — bounded by the registry, since an unknown key 404s first.
  wrapHttp: (key, fn) =>
    recordEntrySpan("http", `GET /api/resources/${key}`, fn),
  // A window resource's ids-only membership query, as its own kind so it is told
  // apart from the value query and stays out of the loader read-set index.
  wrapMembership: (key, fn) => recordEntrySpan("membership", key, fn),
  // Origin entry for sub-ack / push-cascade loads: gives the nested loader span a
  // non-null `parent` naming the request class that triggered it, so head-of-line
  // blocking is attributable. See
  // research/2026-06-19-global-wait-attribution-instrumentation.md.
  wrapOrigin: (kind, key, fn) => recordEntrySpan(kind, key, fn),
  // The notify-flush cycle as one `flush` entry — the per-resource `push` loads
  // it triggers nest under it (byParent = head-of-line attribution). See
  // research/2026-06-19-global-observability-frequency-delivery-and-dead-job-gc.md.
  wrapFlush: (fn) => recordEntrySpan("flush", "flushNotifies", fn),
  // Delivery latency as a `push` leaf under the active `flush` entry: enqueue→send
  // time per resource (first-notify staleness window). Attributes to the resource.
  // Fan-out and frame size ride as measures, so a delivery slowed by a wide
  // fan-out or a huge frame says so on its own slow-op row. `sinceChangeMs` (the
  // change's wall clock → send, when the change has one) shows what `latencyMs`
  // cannot: time the change waited before this thread read its NOTIFY (an open
  // writing transaction, a stalled serving thread).
  onDelivered: (key, info) => {
    recordSpan("push", `deliver:${key}`, info.latencyMs, {
      measures: {
        subscribers: info.subscribers,
        frameChars: info.frameChars,
        ...(info.changedAt !== undefined
          ? { sinceChangeMs: Math.max(0, Date.now() - info.changedAt) }
          : {}),
      },
    });
    for (const observer of deliveryObservers) observer(key, info);
  },
  // Read-admission gate queue-wait, charged to the enclosing `sub` entry (mirrors
  // the DB background query gate's `background-acquire`), so a saturated read cap is visible in
  // get_runtime_profile as a `read-admit` wait rather than hidden queue time.
  onReadGateWait: (ms) => chargeWait("read-admit", ms),
  // Read-path single-flight coalescing wait (mirrors read-admit): the time a
  // JOINING caller spent awaiting another caller's in-flight loader for the
  // same (key, params), charged to the joiner's own enclosing entry.
  onCoalesceWait: (ms) => chargeWait("read-coalesce", ms),
  // Loader frequency for the _debug endpoint: find this key's loader aggregate in
  // the current profiling window and derive count / calls-per-minute / slowest.
  loaderStats: (key) => {
    const profile = getRuntimeProfile();
    const agg = profile.aggregates.loader.find((a) => a.label === key);
    if (!agg) return undefined;
    const windowMin = Math.max(
      (performance.now() - profile.sinceMs) / 60_000,
      1 / 60_000,
    );
    return {
      count: agg.count,
      ratePerMin: agg.count / windowMin,
      maxMs: agg.maxMs,
    };
  },
  // Automatic loader→table read-set: the tables each loader actually read,
  // captured at the DB pool chokepoint into the runtime-owned sink (./read-set —
  // independent of the profiler's kill-switch and resets). The legacy router
  // inverts it, and the _debug endpoint shows it. central: omitted.
  readSet: (key) => readSetOf(key),
  // The sink's version: the legacy router's table → resource memo key.
  readSetVersion: () => readSetVersion(),
  // Per-run read-set of the key's LAST loader run — the self-healing capture the
  // runtime persists after a FULL recompute (replace, not union), so a dropped
  // dependency is shed from the durable `tables_read` seed instead of carried
  // forever. central: omitted (undefined → persist falls back to `readSet`).
  lastReadSet: (key) => getLastLoaderReadSet(key),
  // A8: a routed resource reading a table none of its routes names fails its
  // load under a test runner (bun:test sets NODE_ENV=test), and is reported
  // once per table in a running server.
  strictRoutes: process.env.NODE_ENV === "test",
  // The legacy router's read-set expansion (and the _debug read-set bases):
  // the boot-injected holder, read at call time — it throws until change-feed
  // sets it. central: omitted (identity).
  relationBases: (r) => relationBasesOf(r),
  // L2 persisted materialization. All three read the boot-injected holder at call
  // time (set by the live-state-snapshot plugin once the DB is ready). Until then
  // — and on central, which never installs them — `shouldPersist` returns false,
  // so no resource is ever persisted and the capture/persist hooks are never hit.
  shouldPersist: (key) => liveStateSnapshotHooks?.shouldPersist(key) ?? false,
  captureWatermark: () => {
    if (!liveStateSnapshotHooks) {
      // Unreachable: the runtime only calls this when shouldPersist returned true,
      // which requires the hooks to be installed. Fail loudly if that invariant
      // is ever violated rather than persisting a value with no watermark.
      throw new Error(
        "captureWatermark called before live-state-snapshot hooks installed",
      );
    }
    return liveStateSnapshotHooks.captureWatermark();
  },
  persistSnapshot: (key, paramsKey, value, watermark, meta) => {
    if (!liveStateSnapshotHooks) {
      throw new Error(
        "persistSnapshot called before live-state-snapshot hooks installed",
      );
    }
    return liveStateSnapshotHooks.persistSnapshot(
      key,
      paramsKey,
      value,
      watermark,
      meta,
    );
  },
  reportError: (ctx, err) => reportServerError(errorReport(ctx, err)),
  // Reads the boot-injected holder at call time (see `setClientBuildIdentity`).
  serverBuildGraph: () => clientBuildIdentity(),
  // Fan each push outcome out to every registered observer (no-op detector et al).
  onPush: (key, info) => {
    for (const cb of pushObservers) cb(key, info);
  },
  debugOwners: () =>
    Resource.Declare.getContributions().map((c) => ({
      key: c.key,
      pluginId: c._pluginId,
    })),
});

// Occupancy gauge for the read-admission gate, under the same layer name as its
// `onReadGateWait` charge above — the flight recorder's gate snapshot joins
// occupancy to `read-admit` span waits. Registered here (not in the runtime)
// because resource-runtime stays profiler-free; central never registers.
registerGateGauge("read-admit", () => runtime.readGateStats());

export const {
  defineResource,
  // Escape-hatch factory: resources whose truth lives outside Postgres keep a
  // callable `notify()`. DB-backed resources use `defineResource` (no `notify`).
  defineExternalResource,
  // A resource whose server half compiles at boot, once contributions are
  // collected (a collection other plugins contribute columns to) — bound by
  // `bindDeferredResources` below, from the shared boot sequence.
  defineDeferredResource,
  notificationsWsHandler,
  handleResourceHttp,
  withNotifyBatch,
  loadResourceByKey,
  // Run + time one full first-subscribe lifecycle (onFirstSubscribe + loader read)
  // then tear it down. Sibling to loadResourceByKey; powers the benchmark harness.
  measureSubscribeCycle,
  // Re-emit a registered resource to its current subscribers without a DB change
  // (a real no-op push). Drives the live-state-churn deterministic-churn emitter.
  triggerResourcePush,
  // L4 DB change-feed router for every non-routed resource: the change-feed's
  // `routeChange` calls it with each change, and each legacy reader of the
  // table (through its relation bases) recomputes FULL.
  applyLegacyFullChange,
  // Scoped change routing for ROUTED entries (compiler-emitted routes): every
  // change producer calls it beside `applyLegacyFullChange`; each entry is
  // served by exactly one of the two.
  routeTableChange,
  // L2 boot init: force a FULL recompute of one resource (no usable persisted
  // read-set yet), re-persisting its value AND read-set for the next boot.
  recomputeResource,
  // L4 self-verification counters (hand vs feed) for the read-set debug pane.
  notifyStatsFor,
  // Every table a routed resource's delivery depends on (each route of a routed
  // entry) — the change-feed cross-checks these against the tables it installed
  // triggers on at boot to reject a route no change can ever reach.
  scopedResourceTables,
  // The trigger layout each routed table needs (carried key columns, the
  // column sets its routes read) — the change feed installs the richer
  // trigger from it.
  routedTableRequirements,
  // Bounded-membership keys (window/point) — the live-state-snapshot boot sweep
  // deletes leftover persisted rows for these (they are never persisted going
  // forward, so any snapshot row is stale from a pre-migration boot).
  boundedMembershipKeys,
  // The keys L2 persists right now (the runtime's own persist gate) — the
  // live-state-snapshot A6 boot check refuses one that reads a produced table.
  persistedKeys,
  // Unbounded-window (scopedMembership alias) keys — the live-state-snapshot boot
  // seed picks these to reconstruct the in-memory diff base from their L2 value.
  unboundedWindowKeys,
  // L2 boot seed: restore a persisted alias's in-memory diff base (and its base
  // floor) before catch-up.
  seedPersistedSnapshot,
  // A30's parse alone: the live-state-snapshot barrier clears every persisted
  // alias row whose value its payload schema rejects, before readiness flips.
  validatePersistedValue,
  // The L2 definition of every persisted key that has one — the expected map
  // every L2 read path matches rows against (A18).
  persistedDefinitions,
  // A persisted alias's current value from its in-memory snapshot — the boot
  // snapshot serves it ahead of the trailing L2 row.
  keptSnapshotValue,
  // Shutdown: drop the armed trailing floor persists (catch-up replays them).
  dropPendingPersists,
} = runtime;

// ── Boot: bind the deferred resources ──────────────────────────────────────
// A deferred resource (`defineDeferredResource`) compiles its server half from
// the plugin graph's contributions, so it binds right after they are collected
// (`../shared/boot-stages.ts`) — before the preload assert below reads the
// registry, and before the ready barrier rebuilds triggers from the route
// layout. Checks over what the binds consumed (`onDeferredResourcesBound`) run
// right after, still inside the boot sequence, so a mis-contributed graph
// never serves.
const boundChecks: (() => void)[] = [];

/**
 * Register a check to run once every deferred resource is bound (a contributor
 * no bind consumed, a duplicate name). Registered at module eval by the
 * plugin that owns the deferred compile; a throw fails boot.
 */
export function onDeferredResourcesBound(check: () => void): void {
  boundChecks.push(check);
}

/** Bind every deferred resource, then run the bound checks. Boot only. */
export function bindDeferredResources(): void {
  runtime.bindDeferredResources();
  for (const check of boundChecks) check();
}

// ── Boot assert: every registered preloaded resource is declared ────────────
// `preload` reaches its consumers ONLY through `Resource.Declare`: the boot
// snapshot's key set and the L2 persist set both read it off the contribution
// set (never the runtime registry — collection-consumer separation). So a
// resource registered with `preload` whose plugin forgot its Declare (a
// `liveValue` / `liveCollection` served without `...served.declare` in
// `contributions`) still serves, and silently loses boot hydration and L2
// persistence — nothing else notices. The shared boot sequence
// (`../shared/boot-stages.ts`) runs this right after `collectContributions`,
// once every server module has registered its resources, in both boot modes.

/**
 * The registered preloaded keys that no `Resource.Declare` contribution carries
 * AS preloaded, sorted. A Declare whose payload lost the flag counts as missing:
 * the consumers filter on it exactly as this does.
 */
export function undeclaredPreloadedKeys(
  preloaded: readonly string[],
  declared: readonly ResourceDeclarePayload[],
): string[] {
  const declaredPreloaded = new Set(
    declared.filter((c) => c.preload !== undefined).map((c) => c.key),
  );
  return preloaded.filter((key) => !declaredPreloaded.has(key)).sort();
}

/**
 * Throw when a resource registered with `preload` has no preloaded
 * `Resource.Declare` contribution, naming every such key. Must run after
 * `collectContributions`: before it, reading the Declare set throws.
 */
export function assertPreloadedResourcesDeclared(): void {
  const undeclared = undeclaredPreloadedKeys(
    runtime.preloadedKeys(),
    Resource.Declare.getContributions(),
  );
  if (undeclared.length === 0) return;
  throw new Error(
    `[resources] ${undeclared.length} preloaded resource(s) registered without a Resource.Declare contribution: ` +
      `${undeclared.map((key) => `"${key}"`).join(", ")}. ` +
      `The boot snapshot and the L2 persist set find preloaded resources only through Resource.Declare, ` +
      `so each would still serve but silently lose its boot hydration and persistence. ` +
      "Spread `...served.declare` into the owning plugin's `contributions` " +
      "(`Resource.Declare(resource)` for a resource still defined with defineResource).",
  );
}
