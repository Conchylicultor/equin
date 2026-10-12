import type { ServerWebSocket } from "bun";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import { createHash, randomUUID } from "node:crypto";
import { createInflight } from "@plugins/packages/plugins/inflight/core";
import { canonicalParams } from "@plugins/packages/plugins/canonical-params/core";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import {
  BUILD_GRAPH_HEADER,
  DERIVE_MAX_ID,
  DERIVE_MAX_SOURCES,
  PROTOCOL,
  ResourceContractError,
  ResourceRefusal,
  contractVerdict,
  resourceBytesHeaders,
  type ContractVerdict,
  type Derivation,
  type DeriveSource,
  type ExactServerFrame,
  type ReceivedFrame,
  type ResourceHttpErrorBody,
  type ServerFrame,
} from "@plugins/packages/plugins/resource-protocol/core";
import {
  buildSnapshot,
  diffKeyedFull,
  diffKeyedScopedMembership,
  hashSnapEncoder,
  retainSnapEncoder,
  type KeyedDiff,
  type SnapEncoder,
  type SnapEntry,
} from "./keyed-diff";
import {
  isMintedPlan,
  routeTuple,
  tableLayoutRequirements,
  type HostMap,
  type ReachPlan,
  type ChangeSource,
  type ReverseRoute,
  type Route,
  type RoutePlan,
  type TableChange,
  type TableLayoutRequirement,
  type TupleRouting,
  type TupleUse,
  type UnresolvedReverse,
} from "./routing";

// Shared live-state resource runtime. See
// research/2026-04-15-global-sse-lifecycle-mental-model-v3.md and
// research/2026-06-08-global-unify-live-state-resource-runtime.md.
//
// This is the single, parameterized implementation behind both the per-worktree
// server runtime (@plugins/framework/plugins/server-core/core) and the central
// runtime (@plugins/framework/plugins/central-core/core). Each facade calls
// `createResourceRuntime(opts)` with its runtime-specific hooks; the ~42
// `defineResource` call sites and ~37 `Resource.Declare` contributors are
// unaffected because the facades re-present this runtime's types and bind its
// returned values.
//
// A plugin calls defineResource({key, loader, schema, mode}). The host exposes:
//   GET /api/resources/:key (or /api/central-resources/:key) — HTTP fallback
//   WS  /ws/notifications  (or /ws/central-notifications)     — single push channel
// and broadcasts updates when the plugin calls resource.notify().
//
// The runtime is acyclic: besides `zod` and `bun` (ServerWebSocket type) it
// imports only the `packages/…` leaves (globally-allowed utility code, so no
// cycle — inflight for read-path single-flight coalescing, semaphore for the
// read-admission gate, zod-parser for the `ZodParser` alias). It declares
// its own local WsData/WsHandler interfaces
// (byte-identical to server-core/central-core's types.ts) rather than importing
// them — importing from either facade would create a cycle. The returned
// `notificationsWsHandler` is structurally assignable to each facade's WsHandler.

// Local, cycle-free copy of the WS types (see server-core/central-core types.ts).
export interface WsData {
  path: string;
}

export interface WsHandler {
  open(ws: ServerWebSocket<WsData>): void;
  message(ws: ServerWebSocket<WsData>, msg: string | Buffer): void;
  close(ws: ServerWebSocket<WsData>, code: number, reason: string): void;
}

export type ResourceMode = "push" | "invalidate" | "keyed";
export type ResourceParams = Record<string, string>;

// Upstream edge: when `resource` notifies, this resource is cascaded.
// `map` translates upstream params (and optionally value) into the list of
// downstream params tuples to schedule. Default: identity (`[upstreamParams]`).
// See `research/2026-04-16-global-derived-state-primitive-v2.md`.
//
// The upstream is always EXTERNAL (T15): a DB-backed resource's writes reach
// every reader of its tables through the change feed already, so a cascade out
// of one would serve its downstream a second time. A DB-backed `Resource` has
// no `notify`, so it is not an `ExternalResource` (type); `createResource`
// still refuses one an erased cast let through.
export interface DependsOnEntry<P extends ResourceParams = ResourceParams> {
  // biome-ignore lint/suspicious/noExplicitAny: upstream type is erased — the map callback owns the shape.
  resource: ExternalResource<any, any>;
  map?: (
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    upstreamParams: any,
    upstreamValue: unknown,
  ) => P[];
  /**
   * Cascade to EVERY currently-subscribed params tuple of this resource (the
   * runtime's own subscription state — `subscribedParamsFor`), whatever the
   * upstream tuple was. Replaces the hand-kept "active set" a `map` used to read
   * back (a module `Set` filled by `onFirstSubscribe` / drained by
   * `onLastUnsubscribe`). Mutually exclusive with `map` (a loud throw at
   * registration). Unlike a `map`, it never forces the upstream's value.
   * Spelled `recomputeOn: [served]` by `network/live`'s `serveValue`.
   */
  toSubscribed?: true;
}

/**
 * One upstream tuple a routed entry recomputes on (`ResourceDefinition.recomputeOn`):
 * an EXTERNAL resource's `params` tuple. Both rules are types: a DB-backed
 * upstream has no `notify` (its writes are the entry's own routes to name), and
 * `params` is checked against the upstream's params, never inferred from them
 * (a tuple that fits no upstream tuple would never match one). `createResource`
 * still refuses a non-external upstream an erased cast let through.
 */
export interface RoutedRecomputeOn<P extends ResourceParams = ResourceParams> {
  // biome-ignore lint/suspicious/noExplicitAny: upstream payload type is erased — only its key is read.
  resource: ExternalResource<any, P>;
  params: NoInfer<P>;
}

/**
 * Bounded-membership selector for a keyed own-identity resource — the
 * generalization of M5 `scopedMembership` to the bounded working-set contract
 * (`research/2026-07-18-global-bounded-working-set-resource-contract.md`). A
 * membership entry's per-(params) value is a BOUNDED subset of the collection,
 * maintained incrementally: a feed change costs O(changed) + O(window), never
 * O(collection).
 *
 * - `kind: "window"` — the params tuple names an ordered window (`WHERE … ORDER
 *   BY … LIMIT n`). `windowIdsOf(params)` is the ids-only bounded ordered id
 *   list for that window — the authority the runtime consults on any potential
 *   membership change (an entrant candidate or a leaver) to re-derive the
 *   window and pull the new tail row in. It MUST carry the window's LIMIT (a
 *   bounded read); the loader at the same params must be the matching windowed
 *   query, so a FULL recompute of a window entry is bounded by construction.
 * - `kind: "point"` — the params tuple names an explicit id set. `idsOf(params)`
 *   decodes it (pure, synchronous, cheap — it runs per subscribed tuple on the
 *   feed-routing path). The entry's loader is the scoped read over those ids; a
 *   feed change routes to a tuple iff the changed ids intersect its set. No ids
 *   query ever runs; point sets are unordered (entrants append).
 *
 * Declaring `membership` requires `mode: "keyed"` + `routes` (enforced
 * with a loud throw, exactly like `scopedMembership`) — or, on an EXTERNAL
 * resource, the routeless window arm `ExternalWindowPolicy` — and marks the entry as
 * BOUNDED: it is excluded from L2 persistence (`live_state_snapshot`) and its
 * keyed snapshot uses the compact hash encoder. The legacy
 * `scopedMembership: { orderOf }` is a thin alias for an UNBOUNDED window
 * (`windowIdsOf = orderOf`, no LIMIT) that keeps the persisted-reconstruction
 * path and the retain encoder — byte-identical to M5. The two fields are
 * mutually exclusive.
 */
export type KeyedMembership<P extends ResourceParams = ResourceParams> =
  | {
      kind: "window";
      windowIdsOf: (params: P) => Promise<string[]>;
      /**
       * Order signature of one wire row: a canonical encoding of exactly the
       * fields the window's ORDER BY reads (pure, cheap — compared for equality
       * only). When present, a refilled MEMBER row whose signature differs from
       * the stored one is treated as membership-affecting: the window is
       * re-derived via `windowIdsOf` (one bounded ids query) and the delta
       * asserts the fresh `order` — so an UPDATE that moves an order column
       * (e.g. a `createdAt` resurface bump) reorders the wire window instead of
       * leaving it stale. Unchanged-signature refills keep the in-place path
       * (no ids query — the M5 cost model for content-only bumps). Absent ⇒
       * in-place updates never re-derive order (byte-identical prior behavior;
       * the ORDER BY must then be update-stable). `params` is the tuple the
       * row belongs to, so a signature can cover only the columns THAT tuple
       * orders by: a write to a column another tuple sorts by then does not
       * cost this one an ids query.
       */
      orderSignatureOf?: (row: unknown, params: P) => string;
      /**
       * The tuple's window size: the LIMIT its loader and `windowIdsOf` both
       * read (pure, cheap). A window holding fewer rows than this is NOT
       * FULL: it holds its whole range, so nothing sorts past its tail. Two
       * paths lean on that:
       * - a membership drain derives an exit (or an in-place change) of a
       *   non-full window from the prior snapshot, with no `windowIdsOf` and
       *   no backfill (`drainMembershipScoped`) — a full one may hide the row
       *   that must fill the freed slot;
       * - with `familyOf`, a fresh tuple may be DERIVED from rows other
       *   tuples of this resource already hold (a `sub` frame's `derive`, see
       *   `handleSub`): the runtime checks a derived slice fits the new
       *   window, and that a source sliced through its end is not full.
       */
      limitOf: (params: P) => number;
      /**
       * The tuple's derivation family: one canonical string for exactly the
       * tuples that read ONE query (the same filter and order), whatever
       * their range and limit. A derivation copies its sources' rows and
       * order signatures as they are, so a source must be of the new tuple's
       * family (`foreign-source` otherwise). Pure and cheap. Absent ⇒ every
       * sub loads.
       */
      familyOf?: (params: P) => string;
    }
  | { kind: "point"; idsOf: (params: P) => readonly string[] };

/**
 * The `scopedMembership` alias — an UNBOUNDED window: `orderOf` is the whole
 * ordered id list (the window loader with no LIMIT). `orderSignatureOf` is the
 * same seam as `KeyedMembership`'s window arm: when present, a refilled member
 * whose ORDER BY projection moved re-derives the order (`orderOf`) instead of
 * keeping its stale position — so an alias over a mutable sort column (a rank, a
 * createdAt resurface) stays ordered. REQUIRED on the routed arm
 * (`ScopePolicy`), where the compiler always knows its ORDER BY and so an
 * in-place reorder can never go stale.
 */
export interface AliasMembership<P extends ResourceParams = ResourceParams> {
  orderOf: (params: P) => Promise<string[]>;
  orderSignatureOf?: (row: unknown, params: P) => string;
}

/**
 * The runtime-internal normalized membership record: the public `membership`
 * field plus the `scopedMembership` alias fold into this one shape, so every
 * consumer (routing, drain, encoder, persistence gate) branches on it alone.
 * `bounded: false` marks the legacy alias — the only unbounded window — which
 * keeps L2 persistence and the retain snapshot encoder.
 */
type MembershipRecord =
  | {
      kind: "window";
      windowIdsOf: (params: ResourceParams) => Promise<string[]>;
      bounded: true;
      /** Order-signature seam — see `KeyedMembership`. */
      orderSignatureOf?: (row: unknown, params: ResourceParams) => string;
      /** The window size — see `KeyedMembership`. */
      limitOf: (params: ResourceParams) => number;
      /** The derivation family — see `KeyedMembership`. */
      familyOf?: (params: ResourceParams) => string;
    }
  | {
      kind: "window";
      windowIdsOf: (params: ResourceParams) => Promise<string[]>;
      /** The alias — unbounded, so it has no window size and never derives. */
      bounded: false;
      /** Order-signature seam — on the alias it makes an order move re-run `orderOf`. */
      orderSignatureOf?: (row: unknown, params: ResourceParams) => string;
    }
  | { kind: "point"; idsOf: (params: ResourceParams) => readonly string[] };

/** A resource's declared freshness — see `ResourceDefinition.freshness`. */
export interface ResourceFreshness {
  kind: "notified" | "immutable" | "fixed" | "snapshot";
  /** Why the value is never told of a change (absent for `"notified"`). */
  reason?: string;
}

export interface ResourceDefinition<
  T,
  P extends ResourceParams = ResourceParams,
> {
  key: string;
  /**
   * How a change reaches a subscriber: `push` ships the new value, `invalidate`
   * tells the client to refetch it, `keyed` ships a per-row delta (requires
   * `keyOf`). Required — there is no default, so every resource states its
   * delivery where it is declared. The two-arg forms derive it: `keyed` from a
   * keyed contract, otherwise the opts' own required `mode`.
   */
  mode: ResourceMode;
  /**
   * Compute the resource value for `params`. When a membership drain refills
   * only the rows a routed change named, `ctx.affectedIds` lists those row ids
   * and the loader returns only those rows (a partial array — the membership
   * diff merges it into the snapshot). Full loads (sub-ack, HTTP fallback,
   * `notify()`, every non-membership drain) pass `ctx === undefined`.
   */
  loader: (
    params: P,
    ctx?: { affectedIds: readonly string[] },
  ) => Promise<T> | T;
  /**
   * Zod schema for the payload. Required. The server parses every loader output
   * against it at load time (single chokepoint in `timedLoad`) before any
   * broadcast — a payload that violates its schema fails loudly instead of
   * shipping. The descriptor exposed to clients carries the same schema so the
   * browser re-parses before the value lands in the TanStack cache. See
   * research/2026-06-08-global-mandatory-resource-schema-server-validation.md.
   */
  schema: ZodParser<T>;
  /**
   * Row identity for `mode: "keyed"` resources. Required (and only meaningful)
   * when `mode === "keyed"`: the loader's `T` must be an array, and `keyOf`
   * extracts a stable id from each row. The server keeps a per-(key,params)
   * snapshot of id→hash and broadcasts only changed rows + the id order, so a
   * single-row change ships one row instead of the whole array. See
   * research/2026-06-05-global-live-state-delta-sync.md.
   */
  // biome-ignore lint/suspicious/noExplicitAny: row type is the element of the array payload — erased here.
  keyOf?: (row: any) => string;
  /**
   * Upstream resources. When any listed resource notifies, this resource is
   * scheduled to notify within the same microtask flush, with per-key /
   * per-params coalescing. Cycles are detected at boot (warn-only in phase 1).
   */
  dependsOn?: ReadonlyArray<DependsOnEntry<P>>;
  /**
   * Opt-in row-level membership scoping (M5) for a keyed resource. When present,
   * an INSERT/DELETE/where-flip routed to the resource no longer forces a FULL
   * recompute: the runtime refills only the changed rows and reconciles
   * membership against the per-pk snapshot, shipping an incremental delta that
   * asserts the new `order`. `orderOf` is the ids-only "full ORDER BY'd id list
   * for these params" query the runtime runs ONLY when a row ENTERS membership
   * (an exit or in-place change derives its order from the prior snapshot, so no
   * query runs). It is an injected closure so `resource-runtime` stays DB-free.
   *
   * Requires `mode: "keyed"` + `routes` (an own-identity routed resource) —
   * enforced with a loud throw in `createResource`. Also relaxes
   * the mutable-`where` rule (a where-flip is detected as an exit/entry). See
   * research/2026-07-03-global-scoped-membership-m5.md.
   */
  scopedMembership?: AliasMembership<P>;
  /**
   * Bounded-membership selector (window / point) — see `KeyedMembership`. The
   * generalization of `scopedMembership` (which remains as the unbounded-window
   * alias); the two are mutually exclusive. Requires `mode: "keyed"` +
   * `routes` (external: no routes — `ExternalWindowPolicy`), enforced with a
   * loud throw in `createResource`. A
   * membership-bounded entry is never L2-persisted and its snapshot uses the
   * hash encoder.
   */
  membership?: KeyedMembership<P>;
  /**
   * Scoped change routing (see `RoutePlan` in `./routing`): every table
   * occurrence this resource's compiled query may read, and how each tuple reads
   * them. Present ⇒ the entry is ROUTED: `routeTableChange` serves it and the
   * legacy read-set path (`applyLegacyFullChange`) never does, so each change reaches it
   * exactly once. Only on a membership entry (`membership` / `scopedMembership`)
   * — enforced by `ScopePolicy` and, for an untyped caller, by a loud throw in
   * `createResource`. Exclusive with `dependsOn`: a routed entry
   * takes no cascade (it routes the tables it reads). Written by a compiler,
   * never by hand: a route's `columns` gate what the SQL references, so a
   * hand-kept list could silently drop an update — a `RoutePlan` is minted by
   * `mintRoutePlan` (type), which only a compiler calls (check), and an unminted
   * plan throws in `createResource`.
   */
  routes?: RoutePlan<P>;
  /**
   * The routed spelling for a NON-keyed (`push` / `invalidate`) entry — a
   * collection's `:groups` aggregate: which tables each tuple reads, with only
   * `full` routes (see `ReachPlan`). Present ⇒ the entry is ROUTED exactly like
   * one declaring `routes` (served by `routeTableChange`, never by the legacy
   * read-set path): a change to a table a tuple reads recomputes that tuple,
   * and a change to any other table reaches nothing. Exclusive with
   * `routes` and `dependsOn`; refused on a keyed or external
   * entry (a throw in `createResource`). Compiler-minted (`mintReachPlan`),
   * like `routes`.
   */
  reach?: ReachPlan<P>;
  /**
   * A ROUTED entry's non-table inputs: upstream tuples of EXTERNAL resources
   * (`defineExternalResource`, truth outside Postgres) whose change means the
   * compiled SQL itself moved under the entry — a DataView surface's custom
   * column definitions, which decide which side-table columns a tuple reads and
   * how their values cast. Each change FULL-recomputes every subscribed tuple
   * and drops their memoized read-sets (`usesOf`), which may name the old
   * vocabulary. Only on a routed entry (`routes`), and only external upstreams:
   * a table-backed upstream's writes are the entry's own routes to name, and a
   * cascade from one would serve the entry twice (A5). Both throw in
   * `createResource`.
   */
  recomputeOn?: ReadonlyArray<RoutedRecomputeOn>;
  /**
   * Fixed-window trailing debounce (ms) for this resource's flushes. When set
   * (and > 0), a `notify()` (or cascaded `mergePending`) into this entry does
   * NOT ride the immediate microtask flush; instead it arms a per-entry timer
   * that triggers a flush after the window. The timer is NOT re-armed on
   * subsequent notifies within the window (fixed window, starvation-free), so a
   * continuously-ticking source still flushes at least every `debounceMs`. The
   * merge into `pendingNotifies` is unchanged, so all coalescing keeps working —
   * the debounce only delays *when* the accumulated pending map drains.
   * Piggyback: if any other (non-debounced) resource triggers a flush during the
   * window, that flush drains this entry's pending too and cancels the timer, so
   * debounced data never adds latency beyond an already-happening flush.
   * Do NOT use on keyed resources driving optimistic-mutation delta-sync —
   * debounce the *source* instead. See
   * research/2026-06-15-global-live-state-cascade-contention.md.
   */
  debounceMs?: number;
  /**
   * Sub-lifecycle hooks. Fire on the 0→1 and N→0 global refcount transitions
   * for a given params tuple (counted across every open socket; a socket
   * closing releases the refs it held).
   */
  onFirstSubscribe?: (params: P) => void | Promise<void>;
  onLastUnsubscribe?: (params: P) => void;
  /**
   * Conditional-revalidation signature (HTTP-ETag / 304 semantics). Optional and
   * opt-in: when present, a cheap "did anything change?" content signature (an
   * ETag) the read path (WS sub-ack + HTTP GET fallback) can compare against the
   * client's last-known value BEFORE running the full loader. On a match the
   * server answers "still current" (a WS `up-to-date` frame / an HTTP `304`)
   * without recomputing, and the client keeps its cached value — collapsing the
   * post-restart resubscribe herd for unchanged resources. It MUST be a
   * conservative over-approximation (≪ the loader in cost, and a fresh/unique
   * value whenever any loader input it cannot cheaply hash might have changed):
   * an occasional needless recompute is fine, serving stale is not. Runs on the
   * read path only, under the same read-admission gate as the loader (it may
   * spawn git/fs). Absent ⇒ today's full-loader behavior, unchanged.
   */
  revalidate?: (params: P) => Promise<string>;
  /**
   * Subscription-authorization seam (deferred; single-instance-per-user). Runs
   * on the subscribe path — before the refcount bump, `onFirstSubscribe`, and
   * the loader — and, if it resolves falsy, refuses the subscription with a
   * `sub-error` (`reason: "unauthorized"`) instead of an initial value.
   *
   * Absent ⇒ the subscription is always allowed. That is the shipped behavior
   * for every resource today: under the one-instance-per-user deployment model
   * (`research/2026-07-02-global-adr-single-instance-per-user.md`) there is
   * exactly one trusted caller, so no resource populates this. The field exists
   * so the authorization boundary is an explicit, typed seam rather than an
   * implicit hole — a future authenticated-gateway / multi-tenant deployment can
   * enforce per-subscription access here without reshaping the sub path. The
   * callback takes only `params` today (the resource key is fixed per entry, and
   * no caller identity is threaded through the socket yet); widening it with a
   * caller-context argument later is a non-breaking additive change.
   *
   * DECLARING IT CURRENTLY THROWS AT REGISTRATION: only the WS subscribe path
   * enforces it — `handleResourceHttp` would serve the value unchecked (and the
   * client heals a `sub-error` via an HTTP refetch), a silent authorization
   * bypass. The guard in `createResource` refuses the declaration until HTTP
   * parity exists; build one shared admission check across handleSub /
   * handleSubBatch / handleResourceHttp, then delete the guard and restore the
   * WS-enforcement tests from history.
   */
  authorize?: (params: P) => boolean | Promise<boolean>;
  /**
   * The declared freshness of an external value (`network/live`'s `changes`):
   * how its answer changes — told by `notify`, never (immutable / fixed), or
   * only when a reader asks (snapshot). A label only: the runtime does not act
   * on it; the `_debug` payload shows it per key.
   */
  freshness?: ResourceFreshness;
  /**
   * The params gate — see `ResourceContract.validateParams`. Required on the
   * two-arg form (the contract carries it); optional only on the flat
   * `defineResource({...})` form, which predates it and declares no param
   * names — absent there ⇒ any params are accepted.
   */
  validateParams?: (params: ResourceParams) => void;
  /**
   * Preload marker (`"boot"` / `"boot-and-keep"`), threaded from the shared
   * client descriptor through the two-arg `defineResource`/`defineExternalResource`
   * form onto the returned `Resource`. Pure metadata: it does not affect
   * loader/registry behavior — it only lets `Resource.Declare` derive the flag
   * instead of restating it, and `preloadedKeys()` list it. Any value preloads
   * server-side; `"boot-and-keep"` differs only on the client (resident cache).
   */
  preload?: "boot" | "boot-and-keep";
  /**
   * The param names that may be absent (a `liveValue`'s `"scopeId?"`), threaded
   * from the shared client descriptor through the two-arg form. An optional
   * param is present iff it is a non-empty string, so the runtime drops an
   * `undefined` or `""` one wherever params ENTER it — a `sub` / `sub-batch` /
   * `unsub` / `sub-acks` frame, the HTTP read, `notify` — and every spelling of
   * "absent" names ONE tuple (its `paramsKey`, its loader call, its
   * subscribers). The frames sent back echo that canonical tuple, so the client
   * must canonicalize the same way — it does, with the same function
   * (`packages/canonical-params`).
   */
  optionalParams?: readonly string[];
  /**
   * The refusal codes the loader may throw (`ResourceRefusal.code`), declared
   * once on the shared client descriptor (a `liveValue`'s `refusals`) so the
   * client can type and check them too. A refusal with any other code is a
   * server bug: `timedLoad` turns it into a plain failure (`loader-failed`,
   * reported), so only a declared code ever reaches the wire. Absent ⇒ none.
   */
  refusals?: readonly string[];
  /**
   * A BYTES resource, declared once on the shared client descriptor (a
   * `liveValue`'s `bytes: true`): the value is an `ArrayBuffer` (its schema
   * checks that), so it never rides a JSON frame. The HTTP read answers it as
   * `application/octet-stream`, the body the value itself and the envelope
   * (version, epoch, watermark) in response headers (`resource-protocol`'s
   * `resourceBytesHeaders`); a sub-ack carries no value and runs no loader —
   * the client answers it with that HTTP read. Mode `invalidate` only (a
   * throw otherwise). Absent ⇒ a JSON value.
   */
  bytes?: true;
}

/**
 * A keyed resource's scope policy — the two questions the feed router asks,
 * both answered at the declaration site or the resource does not compile.
 *
 * **Which RESOURCE does a change belong to?** `routes`: a compiler-minted
 * `RoutePlan` naming every table occurrence the query may read (see
 * research/2026-09-29-global-scoped-change-routing.md).
 *
 * **And which subscribed TUPLE of it owns the changed row?** Exactly one of:
 *
 * - `membership` — the tuple names a bounded window / point set, maintained
 *   incrementally (`KeyedMembership`).
 * - `scopedMembership` — the unbounded-window alias of `membership`, its
 *   `orderSignatureOf` required: a compiler always knows its ORDER BY.
 *
 * A keyed entry is therefore always a routed membership entry: a scoped refill
 * never deletes, so only a membership drain turns a routed change into an exit.
 * A routed arm takes no `dependsOn` either: it routes the tables it reads
 * itself, and a cascade would serve it a second time. There is no
 * `identityTable` / `fanOut` / `recompute` spelling: a cast that smuggles one
 * through throws where the definition enters the runtime
 * (`refuseLegacyScopeKeys`, D37).
 */
export type ScopePolicy<P extends ResourceParams = ResourceParams> =
  | {
      routes: RoutePlan<P>;
      membership: KeyedMembership<P>;
      recomputeOn?: ReadonlyArray<RoutedRecomputeOn>;
      scopedMembership?: never;
      dependsOn?: never;
    }
  | {
      routes: RoutePlan<P>;
      scopedMembership: AliasMembership<P> & {
        orderSignatureOf: (row: unknown, params: P) => string;
      };
      recomputeOn?: ReadonlyArray<RoutedRecomputeOn>;
      membership?: never;
      dependsOn?: never;
    };

/**
 * The window size and family of an EXTERNAL keyed window — `KeyedMembership`'s
 * window arm without what only a routed change reads: no `windowIdsOf` (the
 * runtime derives it from the loader — the tuple's own read, its ids mapped —
 * for the paths that call it) and no `orderSignatureOf` (every change of an
 * external entry is a FULL re-read of the tuple, diffed by key, so no refill
 * ever asks whether a member's order moved).
 */
export interface ExternalWindowMembership<
  P extends ResourceParams = ResourceParams,
> {
  kind: "window";
  /** The tuple's window size — see `KeyedMembership`'s `limitOf`. */
  limitOf: (params: P) => number;
  /** The tuple's derivation family — see `KeyedMembership`'s `familyOf`. */
  familyOf?: (params: P) => string;
}

/**
 * An EXTERNAL resource's keyed arm (D31: an external resource is never ROUTED
 * — its truth is outside Postgres — but it may be keyed): a bounded window
 * whose change arrives as the resource's own `notify(params)`, which re-reads
 * the tuple whole and diffs it by key against its snapshot
 * (`drainMembershipFull`) — keyed `delta` frames, seeded derivation
 * (`familyOf`) and one client cache path, exactly as a routed window has them.
 * No `routes` (nothing routes into it) and no cascade OUT of it (D32: a
 * membership entry has no downstream); it may itself follow external
 * upstreams (`dependsOn`), each change a FULL re-read.
 */
export interface ExternalWindowPolicy<
  P extends ResourceParams = ResourceParams,
> {
  membership: ExternalWindowMembership<P>;
  routes?: never;
  scopedMembership?: never;
  reach?: never;
  recomputeOn?: never;
}

/**
 * The strict public input to the flat one-arg `defineResource` (the runtime
 * keeps the loose `ResourceDefinition` internally). This form is
 * **push/invalidate-only**: a keyed resource cannot be declared this way. Keyed-ness
 * comes SOLELY from the two-arg `defineResource(descriptor, opts)` overload, which
 * derives it from the shared client `KeyedResourceContract` descriptor — so the
 * client always carries the matching `keyOf`. This structurally removes the
 * "server says keyed, client forgot its keyOf → browser crash" class. `mode` is
 * required: the runtime has no default delivery. See
 * research/2026-06-20-global-enforce-keyed-resource-scope-coverage.md.
 */
export type DefineResourceInput<
  T,
  P extends ResourceParams = ResourceParams,
> = Omit<
  ResourceDefinition<T, P>,
  | "mode"
  | "keyOf"
  | "scopedMembership"
  | "membership"
  | "routes"
  | "reach"
  | "preload"
  | "optionalParams"
> & {
  mode: "push" | "invalidate";
};

/**
 * The flat `defineExternalResource` input: the loose `ResourceDefinition`,
 * push / invalidate only (keyed-ness comes solely from a shared keyed
 * contract — the two-arg external window arm), with nothing that routes (D31).
 */
type ExternalDefinition<T, P extends ResourceParams> = ResourceDefinition<
  T,
  P
> & {
  mode: "push" | "invalidate";
  keyOf?: never;
  membership?: never;
  scopedMembership?: never;
  optionalParams?: never;
  routes?: never;
  reach?: never;
  recomputeOn?: never;
};

/**
 * The browser-safe half of a resource declaration: exactly the fields a client
 * `ResourceDescriptor` already carries that the server *also* needs — the `key`,
 * the `schema`, and (for delta-sync) the keyed row identity. `defineResource`'s
 * two-arg form takes one of these and the server supplies only the DB-bound half
 * (`ServerResourceOptions`), so `key` / `schema` / keyed-ness are declared in
 * exactly ONE place — the shared descriptor — instead of being restated on both
 * sides and silently drifting (the "server says keyed, client forgot its keyOf"
 * crash this collapses out of existence). A keyed contract pairs with
 * `KeyedServerResourceOptions`, any other with `ServerResourceOptions`.
 *
 * Matched **structurally**: the live-state `ResourceDescriptor` satisfies this
 * shape without the runtime importing the live-state primitive, so this module
 * stays acyclic. `P` is threaded through the same phantom `__params` the
 * descriptor uses, so the server resource inherits the descriptor's param typing.
 */
export interface ResourceContract<
  T,
  P extends ResourceParams = ResourceParams,
> {
  key: string;
  schema: ZodParser<T>;
  keyed?: { keyOf: (row: unknown) => string };
  /**
   * Preload marker, declared once on the shared client descriptor. Threaded
   * through onto the returned `Resource` so `Resource.Declare` derives its payload
   * from it instead of restating it in server-side opts. See the descriptor in
   * `@plugins/primitives/plugins/live-state/core`.
   */
  preload?: "boot" | "boot-and-keep";
  /** Optional param names — see `ResourceDefinition.optionalParams`. */
  optionalParams?: readonly string[];
  /** Declared refusal codes — see `ResourceDefinition.refusals`. */
  refusals?: readonly string[];
  /** A bytes value — see `ResourceDefinition.bytes`. */
  bytes?: true;
  /**
   * The params gate, declared once on the shared descriptor: throws
   * `ResourceContractError` when a subscription's wire params do not match
   * the declaration. The runtime runs it BEFORE `authorize`, the sub
   * registration and any read (WS and HTTP alike), so a mismatched sub — a tab
   * running an older bundle after a deploy — is refused as
   * `contract-mismatch` and never registered: no push, revalidate or scoped
   * recompute ever reruns it. Required so every descriptor factory decides.
   */
  validateParams: (params: ResourceParams) => void;
  /** Phantom — carries `P` for inference, mirroring the client descriptor. */
  readonly __params?: P;
}

/**
 * A keyed contract — the client descriptor carries a `keyOf` (a
 * `liveCollection`'s window / `:rows` descriptor, whose type makes `keyed`
 * REQUIRED). The
 * server's two-arg `defineResource` matches this overload and pairs it with a
 * mandatory `ScopePolicy`. It is the only keyed `defineResource` form (the flat
 * `DefineResourceInput` is push/invalidate-only), so no keyed resource escapes
 * the scope-coverage invariant.
 */
export type KeyedResourceContract<
  T,
  P extends ResourceParams = ResourceParams,
> = ResourceContract<T, P> & { keyed: { keyOf: (row: unknown) => string } };

/**
 * The fields both two-arg server halves share (see `ServerResourceOptions` and
 * `KeyedServerResourceOptions`). Everything here pulls loader/DB code that must
 * never enter the browser bundle; the browser-safe `key`/`schema`/keyed fields
 * come from the contract.
 */
interface ServerResourceOptionsBase<
  T,
  P extends ResourceParams = ResourceParams,
> {
  loader: ResourceDefinition<T, P>["loader"];
  dependsOn?: ResourceDefinition<T, P>["dependsOn"];
  debounceMs?: number;
  onFirstSubscribe?: ResourceDefinition<T, P>["onFirstSubscribe"];
  onLastUnsubscribe?: ResourceDefinition<T, P>["onLastUnsubscribe"];
  /** Conditional-revalidation ETag signature — see `ResourceDefinition.revalidate`. */
  revalidate?: ResourceDefinition<T, P>["revalidate"];
  /** Deferred subscription-authorization seam — see `ResourceDefinition.authorize`. */
  authorize?: ResourceDefinition<T, P>["authorize"];
  /** Declared freshness, a `_debug` label — see `ResourceDefinition.freshness`. */
  freshness?: ResourceFreshness;
  /**
   * The server's own params gate, REPLACING the contract's — only for a
   * resource whose server serves more than the shared descriptor can declare
   * (a `network/live` collection whose column sets are contributed by other
   * plugins, or are data): its descriptor's decode would refuse their column
   * names. Throws `ResourceContractError` like the contract's. Absent ⇒ the
   * contract's `validateParams`.
   */
  validateParams?: (params: ResourceParams) => void;
}

/**
 * Server-only half of a NON-keyed resource declaration, paired with a
 * `ResourceContract` that has no `keyed` in the two-arg `defineResource` /
 * `defineExternalResource` form. `mode` is required — `push` or `invalidate`,
 * stated where the resource is declared; the runtime has no default. Never a
 * membership: that is keyed-only. A compiler may declare `reach` (`ReachPlan`),
 * which routes the entry by the tables each tuple reads — exclusive with
 * `dependsOn`, since a routed entry takes no cascade.
 */
export type ServerResourceOptions<
  T,
  P extends ResourceParams = ResourceParams,
> = ServerResourceOptionsBase<T, P> & {
  mode: "push" | "invalidate";
} & ({ reach?: never } | { reach: ReachPlan<P>; dependsOn?: never });

/**
 * Server-only half of a KEYED resource declaration, paired with a
 * `KeyedResourceContract`. There is no `mode`: keyed-ness comes solely from the
 * contract's `keyOf`, so the server cannot state a delivery the client does not
 * share. `defineResource`'s keyed overload intersects `ScopePolicy`, which makes
 * `routes` mandatory and one of `membership` / `scopedMembership`, so which
 * subscribed tuple owns a changed row is answered too rather than defaulting to
 * waking all of them.
 */
export interface KeyedServerResourceOptions<
  T,
  P extends ResourceParams = ResourceParams,
> extends ServerResourceOptionsBase<T, P> {
  mode?: never;
}

// The legacy scope-policy keys (D37). The types do not spell them, so only a cast can carry one in — and it would silently do
// nothing, since no router reads it. Refused by name instead, wherever a
// definition enters the runtime (`contractToDefinition`, `buildEntry`).
const LEGACY_SCOPE_KEYS = ["identityTable", "recompute", "fanOut"] as const;

function refuseLegacyScopeKeys(where: string, key: string, obj: object): void {
  const found = LEGACY_SCOPE_KEYS.filter((k) => k in obj);
  if (found.length > 0) {
    throw new Error(
      `${where}: "${found.join('", "')}" on key "${key}" — the legacy scope policy is gone: a keyed entry routes through a compiler-minted "routes" plan and a membership, and a non-keyed one is reached through its read-set (or "reach")`,
    );
  }
}

// Fold a (contract, server-opts) pair into the flat `ResourceDefinition` the
// runtime registers. Pure — keyed-ness comes solely from the contract, so the
// server cannot disagree with the client about it. The scope policy (the keyed
// overload's `ScopePolicy`: `routes` and a membership) is threaded through.
// `opts` is the union the overloads narrow; an untyped caller that breaks the
// pairing — or casts a legacy scope key through — throws here rather than
// registering a guessed mode or a dead option.
function contractToDefinition<T, P extends ResourceParams>(
  form: "defineResource" | "defineExternalResource",
  contract: ResourceContract<T, P>,
  opts: ServerResourceOptionsBase<T, P> & {
    mode?: "push" | "invalidate";
    scopedMembership?: ResourceDefinition<T, P>["scopedMembership"];
    membership?: ResourceDefinition<T, P>["membership"];
    routes?: ResourceDefinition<T, P>["routes"];
    reach?: ResourceDefinition<T, P>["reach"];
    recomputeOn?: ResourceDefinition<T, P>["recomputeOn"];
  },
): ResourceDefinition<T, P> {
  refuseLegacyScopeKeys(form, contract.key, opts);
  let mode: ResourceMode;
  if (contract.keyed) {
    if (opts.mode !== undefined) {
      throw new Error(
        `defineResource: a keyed contract takes no mode (it is "keyed", from the contract's keyOf) — drop mode "${String(opts.mode)}" for key "${contract.key}"`,
      );
    }
    mode = "keyed";
  } else {
    if (opts.mode !== "push" && opts.mode !== "invalidate") {
      throw new Error(
        `defineResource: mode "push" | "invalidate" is required for key "${contract.key}", got ${String(opts.mode)}`,
      );
    }
    mode = opts.mode;
  }
  return {
    key: contract.key,
    schema: contract.schema,
    mode,
    keyOf: contract.keyed?.keyOf,
    preload: contract.preload,
    ...(contract.optionalParams !== undefined
      ? { optionalParams: contract.optionalParams }
      : {}),
    ...(contract.refusals !== undefined ? { refusals: contract.refusals } : {}),
    ...(contract.bytes === true ? { bytes: true as const } : {}),
    loader: opts.loader,
    dependsOn: opts.dependsOn,
    scopedMembership: opts.scopedMembership,
    membership: opts.membership,
    routes: opts.routes,
    reach: opts.reach,
    ...(opts.recomputeOn !== undefined
      ? { recomputeOn: opts.recomputeOn }
      : {}),
    debounceMs: opts.debounceMs,
    onFirstSubscribe: opts.onFirstSubscribe,
    onLastUnsubscribe: opts.onLastUnsubscribe,
    revalidate: opts.revalidate,
    authorize: opts.authorize,
    ...(opts.freshness !== undefined ? { freshness: opts.freshness } : {}),
    validateParams: opts.validateParams ?? contract.validateParams,
  };
}

export interface Resource<T, P extends ResourceParams = ResourceParams> {
  key: string;
  mode: ResourceMode;
  schema: ZodParser<T>;
  /**
   * Preload marker, derived from the shared client descriptor (via the
   * two-arg `defineResource`/`defineExternalResource` form). `Resource.Declare`
   * reads it to build its contribution payload — the single source of truth.
   */
  preload?: "boot" | "boot-and-keep";
  load(params: P): Promise<T>;
}

/**
 * A resource whose truth lives OUTSIDE Postgres (git refs, file watchers,
 * transcript reads, in-memory registries, the secrets API). The DB change-feed
 * can never observe these, so they keep an explicit hand-`notify()` — declared
 * via `defineExternalResource`, which is the only way to get a callable `notify`.
 * A DB-backed resource (declared with plain `defineResource`) has no `notify`
 * method at all, so hand-notifying it is a compile error. See
 * research/2026-06-20-global-remove-hand-notify-dependson.md §2.
 */
export interface ExternalResource<
  T,
  P extends ResourceParams = ResourceParams,
> extends Resource<T, P> {
  /**
   * Signal that state has changed: a FULL recompute of the tuple. No-arg =
   * parameterless resource. (An external resource is never routed, so there
   * are no row ids to scope a recompute to: a keyed external window re-reads
   * the tuple whole and ships its keyed diff.)
   */
  notify(params?: P): void;
}

interface DownstreamEdge {
  downstreamKey: string;
  map?: (
    upstreamParams: ResourceParams,
    upstreamValue: unknown,
  ) => ResourceParams[];
  /** Cascade to every subscribed downstream tuple (see DependsOnEntry.toSubscribed). */
  toSubscribed?: true;
  /**
   * A routed downstream's `recomputeOn` edge: cascade only when THIS upstream
   * tuple (its canonical params key) changed, and drop the downstream's
   * memoized read-sets first — its compiled vocabulary moved.
   */
  routedRecompute?: { upstreamPk: string };
}

// A coalesced pending notify for one params-tuple. `affected === null` means
// FULL recompute (sticky/absorbing): once a flush has any id-less contributor
// the pk stays FULL. A non-null Set scopes the recompute to those row ids —
// a routed membership entry's only (A25: every other entry recomputes FULL).
interface PendingNotify {
  params: ResourceParams;
  affected: Set<string> | null;
  /**
   * op-D row ids (M5 `scopedMembership` only). Set ONLY for a scopedMembership
   * entry's DELETE — `affected` then carries no id for them (a deleted row cannot
   * be refilled), so `deleted` is the separate channel that drives the membership
   * diff's exit path. Absorbed/dropped by a FULL contributor exactly like
   * `affected` (see `mergePending`). Undefined for every non-membership pending
   * (the legacy drain is FULL-only).
   */
  deleted?: Set<string>;
  /**
   * `performance.now()` of the FIRST notify that opened this pending entry — the
   * moment the resource became stale. Set only in the `!existing` branch of
   * `mergePending` and NEVER overwritten on re-merge (coalesce / debounce re-arm
   * / cascade re-merge all route through `mergePending`), so the delivery-latency
   * window measures real staleness from first notify to send, not ~0. Read once
   * in `flushNotifies` to compute `onDelivered` latency.
   */
  enqueuedAt: number;
  /**
   * `performance.now()` of the MOST RECENT notify merged into this pending — the
   * drain's freshness floor: every change coalesced here was committed before
   * this instant (a `pg_notify` is delivered only after its transaction commits,
   * and this is stamped after the listener routed the change). A read flight
   * that started earlier may have SELECTed before those commits, so a drain
   * passes this as `notBefore` and refuses to mint a new version off such a
   * flight. See research/2026-08-08-global-live-state-flight-freshness.md.
   *
   * NOT the same field as `enqueuedAt`, and the two must NOT be merged.
   * `enqueuedAt` is the FIRST notify: it opens the staleness window and feeds the
   * `onDelivered` delivery-latency metric, so it is never overwritten.
   * `lastNotifyAt` is the LAST notify and is overwritten on every merge; using
   * `enqueuedAt` as the floor would let a flight that predates a later coalesced
   * commit still qualify — exactly the bug.
   */
  lastNotifyAt: number;
  /**
   * WALL-CLOCK instant (epoch ms, `Date.now()`-comparable) of the EARLIEST change
   * folded into this pending: the change-feed's `clock_timestamp()` for a DB
   * change, the `notify()` call for an external resource. Set on the first merge
   * and only ever LOWERED afterwards (`Math.min`), so a coalesced pending reports
   * its oldest change. It rides every value frame so the TAB can measure
   * change → applied on a clock the serving thread does not own: `enqueuedAt`
   * above is stamped when this thread finally reads the NOTIFY, so a stalled
   * thread hides its own delay from `onDelivered`. Observability only — nothing
   * in the runtime reads it back. Comparing it to the tab's `Date.now()` assumes
   * browser, backend and Postgres share one machine clock (one instance per
   * user). Absent for synthetic and ack-only pendings and for catch-up replay.
   */
  changedAt?: number;
  /**
   * Source transaction ids (`pg_current_xact_id()::text` from the change-feed
   * NOTIFY) of the DB changes coalesced into this pending — the mutation-ack
   * attribution (`ackTx`) the drain stamps on the frames this recompute
   * produces. Unioned on EVERY merge branch, INCLUDING the FULL absorb/degrade
   * (a FULL recompute reads post-commit, so the "W's rows have been re-read"
   * claim survives the scope degrade — contrast `deleted`, which FULL drops).
   * Absent for hand-`notify()` / synthetic pendings (no HTTP mutation
   * corresponds), so those frames are structurally ack-less.
   */
  sourceTx?: Set<string>;
  /**
   * The union above crossed `SOURCE_TX_CAP` — ship NO ackTx this cycle (the set
   * is cleared: a missing ack is safe, degrading to the client's watermark
   * backstop; a torn set could confirm an op whose rows were never re-read).
   */
  sourceTxOverflow?: boolean;
  /**
   * Reverse routes (`HostMap` kind `reverse`) this tuple reads whose changed
   * values still have to be resolved to host ids — by route id. The drain
   * resolves them once per (entry, route, flush), before it branches, and merges
   * the answer into `affected` (`resolveReverseRoutes`), so the ack of a change
   * leaves only after every route of it has landed. Follows `affected`: FULL
   * absorbs / drops it, scoped ∪ scoped unions it. Routed entries only.
   */
  unresolved?: Map<string, PendingReverse>;
}

/** One reverse route's changed values awaiting resolution on a pending. */
interface PendingReverse {
  route: ReverseRoute;
  changed: Set<string>;
  /**
   * Some contributor read this route in the `membership` role (or was not
   * quiescent when routed), so its answer may not be bounded by the members the
   * tuple already holds.
   */
  membership: boolean;
}

/**
 * What one read flight co-produces (see `getResourceValue`): the value, the
 * etag it was seeded with, its commit watermark, the ackTx it may stamp, and the
 * tuple's version when its read started.
 */
interface FlightValue {
  value: unknown;
  etag: string | undefined;
  watermark: string | undefined;
  ackTx: readonly string[] | undefined;
  baseVersion: number;
}

/**
 * The xids owed to one tuple a change SKIPPED — a point empty-intersection, or a
 * routed tuple none of whose routes saw a relevant row. Kept apart from
 * `pendingNotifies` so a skip can never be spelled as a recompute: the drain
 * folds the xids into that tuple's real pending when one exists, and otherwise
 * broadcasts a standalone ack before any persisted / membership branch runs.
 */
interface PendingAck {
  params: ResourceParams;
  xids: Set<string>;
  /** The union crossed `SOURCE_TX_CAP` — ship no ack this cycle (see `sourceTxOverflow`). */
  overflow: boolean;
}

/**
 * A routed entry's plan, indexed for the router (see `ResourceDefinition.routes`
 * and, for a non-keyed entry, `ResourceDefinition.reach`).
 */
interface RoutingRecord {
  plan: RoutePlan<ResourceParams>;
  /** The entry's routes on each table (a self-join puts several on one). */
  byTable: Map<string, Route[]>;
  routeIds: Set<string>;
  /** Each route's declared `match` columns, by route id. */
  matchOf: Map<string, readonly string[]>;
  /**
   * The derived tables (rollups) the plan reads beside its route tables
   * (`RoutePlanInput.derivedReads`) — each reached through its sources' routes,
   * which `mintRoutePlan` asserted are all the plan's own (A22), so the drift
   * guard accepts them in a capture.
   */
  derived: ReadonlySet<string>;
  /**
   * A8: the tables a loader run read that no route names, each reported once
   * (see `checkRouteDrift`).
   */
  drifted: Set<string>;
  /**
   * Memoized `usesOf` per tracked pk. `null` = the answer was unusable (it threw
   * or named an unknown route id) — reported once, and that tuple recomputes FULL
   * on every change of its tables. Evicted with the tuple (N→0).
   */
  uses: Map<string, ReadonlyMap<string, TupleUse> | null>;
}

/**
 * A `TupleRouting` after the runtime shaped it (`shapeForTuple`): a point tuple's
 * hosts cut to its own ids, then — one rule for every kind — each value-only host
 * either kept as `affected` (the tuple holds it, or is not quiescent) or dropped,
 * so no unshaped `valueOnly` set can reach the scheduler.
 */
type ShapedRouting =
  | Exclude<TupleRouting, { kind: "scoped" }>
  | {
      kind: "scoped";
      affected: Set<string>;
      deleted: Set<string>;
      unresolved: UnresolvedReverse[];
    };

interface RegistryEntry {
  key: string;
  mode: ResourceMode;
  /** Optional param names — see `ResourceDefinition.optionalParams`. */
  optionalParams?: readonly string[];
  /** Declared refusal codes — see `ResourceDefinition.refusals`. */
  refusals?: readonly string[];
  /** A bytes value — see `ResourceDefinition.bytes`. */
  bytes?: true;
  /**
   * True when declared via `defineExternalResource` — the resource's truth lives
   * outside Postgres, so a hand-`notify()` is legitimate. The backstop check
   * (`no-db-backed-notify`) fails if such a resource's loader reads the DB.
   * Surfaced in the `_debug` payload.
   */
  externalSource?: boolean;
  /** Declared freshness (`ResourceDefinition.freshness`) — surfaced in `_debug`. */
  freshness?: ResourceFreshness;
  /** Payload schema. The loader output is parsed against it in `timedLoad`. */
  schema: ZodParser<unknown>;
  loader: (
    params: ResourceParams,
    ctx?: { affectedIds: readonly string[] },
  ) => Promise<unknown> | unknown;
  /** Row identity for keyed mode. Undefined for push/invalidate entries. */
  keyOf?: (row: unknown) => string;
  /**
   * Normalized membership record (see `MembershipRecord`): the public
   * `membership` selector or the `scopedMembership` alias (an unbounded
   * window, `bounded: false`). Present ⇒ `drainEntry` runs the
   * incremental membership path (`diffKeyedScopedMembership`) instead of a FULL
   * recompute. Present exactly on keyed entries (keyed ⇒ membership; routed
   * when DB-backed, an external window otherwise — whose every change is FULL);
   * undefined ⇒ a non-keyed entry, which always recomputes FULL. See
   * research/2026-07-03-global-scoped-membership-m5.md
   * and research/2026-07-18-global-bounded-working-set-resource-contract.md.
   */
  membership?: MembershipRecord;
  /**
   * The definition's preload marker (see `ResourceDefinition.preload`). Read
   * ONLY by `preloadedKeys()`; the runtime never branches on it.
   */
  preload?: "boot" | "boot-and-keep";
  /**
   * Per-pk snapshot of id→SnapEntry for keyed entries. Allocated lazily only
   * when `mode === "keyed"`. Lets the diff ship only changed rows. Evicted
   * per-pk on the N→0 sub transition so memory is bounded to actively-observed
   * pks. The entry representation is per-resource (see `snapEncoderFor`): a
   * 64-bit content hash by default, the full canonical JSON string for
   * `scopedMembership` entries (their persist path parses it back).
   */
  snapshots?: Map<string, Map<string, SnapEntry>>;
  /**
   * Per-pk order-signature map (member id → order signature) for a window
   * membership entry that declared `orderSignatureOf`. Tiny — window-sized, one
   * short string per member. Lifecycle identical to `snapshots`: seeded/replaced
   * wherever the keyed snapshot is (sub-ack seed, membership FULL rebuild),
   * maintained in lockstep by the incremental membership path, evicted with the
   * snapshot on the N→0 sub transition. Undefined for every other entry.
   */
  orderSigs?: Map<string, Map<string, string>>;
  /**
   * Monotonic count of state changes (notifies) per params-tuple. Bumped in
   * flushNotifies — a real state change — and once when a tracking span opens
   * (the global 0→1 in `registerSubOnSocket`: nothing tracked the tuple before
   * it, so no earlier version may match again). sub-acks and the HTTP fallback
   * REPORT this value without bumping (a read is not a change), and a
   * resubscribe of a tuple the server still holds opens no span — so a forced
   * resync on the same socket (which re-subscribes every sub) does not make the
   * version appear to advance. The client's probeMissedUpdates compares it
   * across a hidden→visible resync to detect frames it missed while hidden;
   * it skips a channel whose socket reopened mid-probe, where the replay opens
   * new spans by design.
   */
  versions: Map<string, number>;
  /** Coalesced pending notifies per params-tuple. */
  pendingNotifies: Map<string, PendingNotify>;
  /** Fixed-window trailing debounce (ms) for this entry's flushes. 0/undefined = immediate. */
  debounceMs?: number;
  /**
   * Armed debounce timer handle, or undefined when not armed. Set when the first
   * notify in a window arrives; cleared on fire (which schedules a flush) or when
   * `flushNotifies` drains this entry's pending out from under it (piggyback).
   */
  debounceTimer?: ReturnType<typeof setTimeout>;
  /** Global subscriber refcount per params-tuple (across all sockets). */
  subCounts: Map<string, number>;
  /**
   * The subscribed tuples, pk → params: maintained next to `subCounts` (set on
   * the global 0→1, deleted on N→0), so the router reads the tuples it must
   * consider in O(tuples) instead of scanning every socket.
   */
  tracked: Map<string, ResourceParams>;
  /**
   * The tracking span each subscribed tuple is in, pk → span number: a fresh
   * number at the global 0→1, deleted at N→0 (lifecycle of `tracked`). A drain
   * captures its tuple's span before it awaits and writes the snapshot it
   * computed only if the span is still the same (`snapshotOwner`): a drain that
   * outlived the last unsubscribe would otherwise resurrect a snapshot nothing
   * routes to any more, and the router would read membership off it once the
   * tuple is subscribed again.
   */
  spans: Map<string, number>;
  /** Acks owed to tuples a change skipped — see `PendingAck`. */
  pendingAcks: Map<string, PendingAck>;
  /**
   * The pks whose pending this entry's drain has taken and not finished — set at
   * the drain's snapshot+clear, cleared when the drain settles. With
   * `pendingNotifies` it defines a QUIESCENT tuple: the router may drop a
   * value-only change to a non-member — of any membership kind, point included —
   * only when neither holds its pk, since a drain admitting that host may
   * already have read the side table before the write committed.
   */
  draining: Set<string>;
  /** Present ⇒ a routed entry (see `ResourceDefinition.routes`). */
  routing?: RoutingRecord;
  /**
   * Per-pk L2 base floor of a persisted unbounded-window alias: the commit
   * watermark of the FULL read the in-memory snapshot was last rebuilt from
   * (the FULL drain's flight watermark, the sub-ack seed's, or the L2 row's
   * position at the boot seed). The snapshot reflects every commit below it,
   * and every routed commit at or above it either reached the snapshot or is
   * still in flight — so it, never a drain-time capture, is the catch-up floor
   * a floor persist may write: a scoped refill reads only the requested ids,
   * so a capture taken at the drain could pass over an unrouted commit below
   * it. Absent ⇒ unknown (a capture failed): no floor persist until the next
   * FULL rebuild sets one. Lifecycle identical to `snapshots`.
   */
  baseFloors?: Map<string, string>;
  /** Upstream keys this entry listens to (for cycle detection). */
  upstreamKeys: string[];
  /**
   * Longest-path depth from a root (no-upstream entry = 0). Computed in
   * `rebuildDag`; every `dependsOn` edge strictly increases depth, so entries
   * sharing a depth are mutually independent and flush concurrently.
   */
  depth?: number;
  /** Downstream entries to cascade to when this entry notifies. */
  downstream: DownstreamEdge[];
  onFirstSubscribe?: (params: ResourceParams) => void | Promise<void>;
  onLastUnsubscribe?: (params: ResourceParams) => void;
  /**
   * Conditional-revalidation ETag signature (see `ResourceDefinition.revalidate`).
   * Undefined ⇒ the resource has not opted in and every read path runs the full
   * loader exactly as before.
   */
  revalidate?: (params: ResourceParams) => Promise<string>;
  /**
   * Deferred subscription-authorization seam (see `ResourceDefinition.authorize`).
   * Undefined ⇒ every subscription to this resource is allowed (the shipped
   * single-instance-per-user behavior). When present, `handleSub` awaits it
   * before any side effect and refuses the sub with `sub-error`/`unauthorized`
   * if it resolves falsy.
   */
  authorize?: (params: ResourceParams) => boolean | Promise<boolean>;
  /**
   * The params gate (see `ResourceContract.validateParams`). Always present: a
   * flat-form definition without one gets `acceptAnyParams`.
   */
  validateParams: (params: ResourceParams) => void;
}

/**
 * The params gate of a flat-form definition that declares none: the flat form
 * names no params, so nothing can be checked. Named so the choice is visible.
 */
function acceptAnyParams(_params: ResourceParams): void {}

/** Why a derivation fell back to a load — the `_debug` payload's `deriveFallbacks` keys. */
type DeriveRefusal =
  /**
   * The sub names another frame vocabulary than this server's (`protocol` ≠
   * `PROTOCOL`, or absent: a bundle that predates it) — its derivation may
   * mean something else here, so it is not read at all.
   */
  | "protocol-skew"
  /** Not a bounded window that states its `familyOf` (or a `revalidate` resource). */
  | "not-derivable"
  /** The tuple was already subscribed: its first subscriber decided how it loaded. */
  | "held"
  /** The frame's `derive` did not parse (or names more than `DERIVE_MAX_SOURCES`). */
  | "malformed"
  /** A source is not a subscribed tuple with a snapshot (or names the new tuple). */
  | "source-not-held"
  /** A source reads another query than the new tuple (`familyOf` differs). */
  | "foreign-source"
  /** A source has a change pending or draining: not quiescent. */
  | "source-busy"
  /** A source's version moved past the one the client sliced. */
  | "source-moved"
  /** A slice bound names no row of its source, or ends before it starts. */
  | "slice"
  /** A source sliced through its end is full: it may hide rows past its last. */
  | "source-full"
  /** Two slices share a row. */
  | "overlap"
  /** The slices hold more rows than the new window. */
  | "over-limit";

/**
 * One socket-held subscription record for a (key, paramsKey): the params object
 * plus WHICH tabs behind this socket hold it. The shared-WebSocket client is one
 * socket for N tabs and every tab sends its own sub frames, so a socket's sub set
 * is the UNION of its tabs'. Tagging each pk with its holders lets one tab depart
 * (`op:"unsub-tab"`, or a `sub-batch complete:true` reconciliation) without
 * tearing down subs the other tabs still hold — before this, a closed follower
 * tab's subs leaked until the whole socket cycled. Legacy untagged frames land in
 * the `""` bucket and release only on socket close (the pre-tab behavior).
 * `entry.subCounts` still bumps only on the socket-level 0→1 (pk record created /
 * deleted), and frames are still sent once per socket per pk.
 */
interface SocketSubRecord {
  params: ResourceParams;
  tabs: Set<string>;
  /**
   * The holding tabs that ASKED for standalone ack frames on this tuple — a
   * subset of `tabs`. Client-requested, never declared by the resource: only
   * the client knows it holds an optimistic op whose write may change nothing
   * visible. Every `sub` frame (and `sub-batch` entry) restates its tab's
   * current flag (`acks: true` adds it, absent removes it); an `op: "sub-acks"`
   * frame flips it on a held sub without re-subscribing. Removed with the tab.
   * The socket gets `{ kind: "ack" }` frames for this tuple iff non-empty.
   */
  ackTabs: Set<string>;
}

interface SocketState {
  ws: ServerWebSocket<WsData>;
  /** key -> paramsKey -> record (subscriptions this socket holds, tagged by tab). */
  subs: Map<string, Map<string, SocketSubRecord>>;
}

/** What `wrapLoad` is told about one loader run (see `ResourceRuntimeOptions.wrapLoad`). */
export interface LoadInfo {
  variant?: string;
  scopedIds?: number;
}

export interface ResourceRuntimeOptions {
  /**
   * Wrap each loader call. `info.variant` is the canonical params
   * (`paramsKey`, absent for `{}`); `info.scopedIds` is how many ids a scoped
   * refill read (absent on a FULL load). server: recordEntrySpan("loader", key,
   * fn, detail); central: omit (identity).
   */
  wrapLoad?: (
    key: string,
    info: LoadInfo,
    fn: () => Promise<unknown>,
  ) => Promise<unknown>;
  /**
   * Wrap one `GET /api/resources/:key` request after its key resolved to a
   * registered resource — the ETag/304 path included. server:
   * recordEntrySpan("http", `GET /api/resources/${key}`, fn); central: omit.
   */
  wrapHttp?: (key: string, fn: () => Promise<Response>) => Promise<Response>;
  /**
   * Wrap a window resource's ids-only membership query (`windowIdsOf`), so it
   * is told apart from the value query. Runs inside the drain's `push` origin.
   * server: recordEntrySpan("membership", key, fn); central: omit.
   */
  wrapMembership?: (
    key: string,
    fn: () => Promise<string[]>,
  ) => Promise<string[]>;
  /**
   * Wrap an origin-triggered load so child loader spans (and the gate waits they
   * charge) attribute to the originating request class — `sub` (a tab subscribed),
   * `push` (a drain's load) or `cascade` (a routed entry's reverse-route resolve,
   * `resolveReverseRoutes`). Without it the loader runs with no entry
   * context and gets `parent: null`. server: recordEntrySpan(kind, key, fn);
   * central: omit (identity). See
   * research/2026-06-19-global-wait-attribution-instrumentation.md.
   */
  wrapOrigin?: <R>(
    kind: "sub" | "push" | "cascade",
    key: string,
    fn: () => Promise<R>,
  ) => Promise<R>;
  /**
   * Wrap the entire `flushNotifies` drain so the notify-flush cycle is measured
   * as one `flush` entry and the per-resource `push` loads it triggers nest under
   * it (`byParent` = which resource dominated the cycle → head-of-line). server:
   * recordEntrySpan("flush", "flushNotifies", fn); central: omit (identity). See
   * research/2026-06-19-global-observability-frequency-delivery-and-dead-job-gc.md.
   */
  wrapFlush?: (fn: () => Promise<void>) => Promise<void>;
  /**
   * Report a delivered notify: `latencyMs` = first-notify → send (the
   * "UI is stale" window), `subscribers` = how many sockets received it. server:
   * recordSpan("push", `deliver:${key}`, latencyMs); central: omit (no-op). The
   * leaf `deliver:<key>` span nests under the `flush` entry so latency attributes
   * to the resource. See the doc above.
   */
  onDelivered?: (
    key: string,
    latencyMs: number,
    subscribers: number,
    frameChars: number,
  ) => void;
  /**
   * Per-key loader stats for the `_debug` endpoint: call count, calls-per-minute,
   * and slowest single call over the current profiling window. server: derived
   * from getRuntimeProfile().aggregates.loader (match label === key); central:
   * omit (field absent). Surfaces loader *frequency* — a cheap loader called
   * thousands of times a minute — which the slow-single-call surfaces miss.
   */
  loaderStats?: (
    key: string,
  ) => { count: number; ratePerMin: number; maxMs: number } | undefined;
  /** Report a loader/map/lifecycle failure. console.error ALWAYS fires inside the runtime;
   *  this is the extra hook. server: reportServerError(errorReport(ctx, err)); central: omit. */
  reportError?: (context: string, err: unknown) => void;
  /**
   * Report queue-wait at the read-admission gate (see `READ_LOAD_CONCURRENCY`).
   * Fired once per gated read-path load/revalidate at slot acquisition with the
   * ms spent queueing (≈0 when a slot was free), mirroring the DB loader gate's
   * `onWait`. server: `chargeWait("read-admit", ms)` — attributes the wait to the
   * enclosing `sub` entry so a saturated gate is visible in the profiler;
   * central / before-injection: omitted (no-op). */
  onReadGateWait?: (waitMs: number) => void;
  /**
   * Report queue-wait at the read-path single-flight coalescer (see
   * `getResourceValue`). Fired once per JOINING full load — a caller that found
   * an existing in-flight loader promise for the same (key, params) — with the
   * ms spent awaiting the shared flight (the starter never reports), mirroring
   * the read-admission gate's `onReadGateWait`. server:
   * `chargeWait("read-coalesce", ms)` — attributes the wait to the enclosing
   * entry so time spent coalesced behind another caller's slow loader is
   * visible in the profiler; central / before-injection: omitted (no-op). */
  onCoalesceWait?: (waitMs: number) => void;
  /**
   * Fired once per version short-circuit — a `sub` whose echoed (epoch, version)
   * matched the server's current boot epoch + per-pk version counter and was
   * answered `up-to-date` with NO loader run and NO read-admission slot (see
   * `handleSub`). The runtime also keeps its own per-key counter, surfaced in the
   * `_debug` payload next to `notifyStats`, for live re-validation of the
   * replay-storm fix. server: optional metric hook; central / omitted: no-op.
   */
  onSubShortCircuit?: (key: string) => void;
  /**
   * Fired once per stale-flight supersession — a push drain refused to join an
   * in-flight read that had STARTED before the notify it is draining, and began
   * its own flight instead (see `getResourceValue`'s `notBefore`). A non-zero
   * rate means the pre-commit join is still reachable under load and is now
   * being refused rather than shipped under a fresh version. The runtime also
   * keeps its own per-key counter, surfaced in the `_debug` payload next to
   * `subShortCircuits`. server: optional metric hook; central / omitted: no-op.
   */
  onStaleFlightSupersede?: (key: string) => void;
  /**
   * The build graph this process serves (the web bundle built alongside it),
   * for judging a contract mismatch: a client whose `build` differs is running
   * an older bundle (`skew` — expected, a reload fixes it, only warned), one
   * whose build matches has a real bug (`same-build` — reported). Must be the
   * graph read at BOOT, not a fresh read: the build swaps the served dist
   * before it restarts this process, and the code answering is the boot
   * build's. `null` = unknown. server: boot-injected by `build/server-build-id`
   * through `setClientBuildIdentity`; central: omit (every verdict `unknown`).
   */
  serverBuildGraph?: () => string | null;
  /** Per-key owner metadata for the _debug endpoint. server: from Resource.Declare; central: omit. */
  debugOwners?: () => Array<{ key: string; pluginId?: string }>;
  /** Fired once per push to >=1 subscriber, with whether the push carried a content change.
   *  A `changed: false` push is a wasted no-op (empty keyed diff). */
  onPush?(key: string, info: { subscribers: number; changed: boolean }): void;
  /**
   * Per-key automatic table read-set: the tables this resource's loader actually
   * read (captured at the DB pool chokepoint), unioned over every run. It is the
   * legacy router's table → resource inversion (`applyLegacyFullChange`, for every entry
   * that declares no `routes`), and the `_debug` endpoint shows it with its
   * relation bases — the read-set ceiling of every `legacy-full` entry.
   * server: server-core's runtime-owned read-set sink (captured whatever the
   * profiler's kill-switch says); central: omit (field absent, nothing routes).
   */
  readSet?: (key: string) => string[];
  /**
   * A counter that moves whenever any key's `readSet` answer may have changed
   * (a table gained, seeded or removed). The legacy router memoizes its
   * table → resource inversion on it. Absent ⇒ the inversion is rebuilt on every
   * change (the DB-free harness, whose injected `readSet` has no counter).
   * server: the read-set sink's version; central: omit.
   */
  readSetVersion?: () => number;
  /**
   * The tables the resource's MOST RECENT loader run read (per-run capture,
   * REPLACED each run — not the append-only union `readSet` returns), or
   * `undefined` if none was captured. Used ONLY on the L2 persist seam: after a
   * FULL recompute, the runtime persists THIS into `tables_read` (replace, not
   * union) so a dependency a code change removed — or a historical mis-attribution
   * baked into the seed — is shed instead of carried forever. It is authoritative
   * because every persisted resource FULL-recomputes wholesale, so its last run
   * observed the complete current table set (there are no data-dependent
   * conditional queries among persisted resources — the safety basis; see
   * research/2026-07-07-global-read-set-self-heal-on-full-recompute.md).
   *
   * Deliberately does NOT feed `applyLegacyFullChange`'s live routing — that keeps using
   * the union `readSet`, an over-approximation, so a stale extra edge only causes a
   * wasteful recompute, never a missed live delivery. server: the read-set sink's
   * per-run capture;
   * central: omitted (undefined → the persist falls back to `readSet`).
   */
  lastReadSet?: (key: string) => string[] | undefined;
  /**
   * The route drift guard (A8) throws instead of reporting: a routed entry's
   * loader reading a table none of its routes names fails that load. server:
   * on under a test runner, so a compiler that forgets a table fails its suite;
   * central / DB-free harness: omit (no `lastReadSet`, so the guard is off).
   */
  strictRoutes?: boolean;
  /**
   * The base tables a read of `relation` depends on (C30): a base table is its
   * own base, a view expands to the tables it reads (transitively), and a
   * trigger-maintained rollup to its sources. The legacy router indexes each
   * read-set relation under its bases (`applyLegacyFullChange`), so a reader of
   * a view is reached by a write to any table feeding it; `_debug` shows the
   * expansion as `readSetBases`. server: injected at boot by change-feed (the
   * server-core holder throws if read before); central / DB-free harness:
   * omitted (identity).
   */
  relationBases?: (relation: string) => readonly string[];
  /**
   * L2 persisted materialization — true when this resource key should be
   * persisted to `live_state_snapshot` for instant cold boot. Backed by
   * `preload && !externalSource` (the preloaded, DB-backed set). When it
   * returns true, `drainEntry` forces a FULL recompute even with zero subscribers
   * and persists the value on loader success, floored by the xmin watermark the
   * recompute's own flight captured before its first read. server: injected by
   * the live-state-snapshot plugin at boot
   * (reads the current holder at call time); central / before-injection: omitted
   * (no resource is persisted). See
   * research/2026-06-22-global-live-state-l2-persisted-materialization.md §3.3.
   */
  shouldPersist?: (key: string) => boolean;
  /**
   * Capture the durable monotonic position (the xmin watermark). Called BEFORE
   * the loader's first read, so any write not visible to the loader's snapshot
   * has xid >= this watermark. server:
   * `SELECT pg_snapshot_xmin(pg_current_snapshot())::text` through the pool.
   * The rule is not "one caller" but ONE CAPTURE PER READ: a floor may only
   * describe the read it accompanies. The main caller is every FULL
   * read/recompute flight (`getResourceValue`), captured by the flight's STARTER,
   * feeding BOTH stamps of the value that flight produces:
   *  - the commit watermark on the frames that fully reconcile a client (sub-ack
   *    / update / FULL keyed delta / HTTP body, Rule B′), which the optimistic
   *    client compares against mutation ack tokens (Rule A/B). See
   *    research/2026-07-11-global-never-revert-optimistic-edits.md;
   *  - the L2 persisted value's catch-up floor (when `shouldPersist(key)` is
   *    true) — under-replay impossible; over-replay harmless. The FULL drains
   *    pass the flight's own watermark straight to `persistSnapshot`; capturing
   *    a second one at the drain could floor a joined (older) value with a newer
   *    position, and catch-up would skip the commit it is missing. See
   *    research/2026-08-08-global-live-state-flight-freshness.md.
   * A scoped drain never captures one: its refills read only the requested
   * ids, so no capture taken there describes the whole value. A persisted
   * alias's floor persists use the snapshot's BASE floor instead — the
   * watermark of the FULL read the snapshot was rebuilt from (C19).
   * Absent (central) ⇒ frames ship tokenless and nothing is persisted.
   */
  captureWatermark?: () => Promise<string>;
  /**
   * Persist a value to `live_state_snapshot` under (key, paramsKey) with its
   * catch-up floor. Called only for a value that is whole (never on a loader's
   * failure path), and only when `shouldPersist(key)` is true; per (key,
   * paramsKey) the calls are serialized, never concurrent. `meta.mode`:
   *
   *  - `replace` — a FULL recompute's value, floored by the watermark its own
   *    flight captured: the row's position, `position_at`, `tables_read`
   *    (`meta.guardTables`, the run's read-set) and definition are all
   *    replaced;
   *  - `floor` — a persisted alias's value reconstructed from its in-memory
   *    snapshot after scoped refills (a trailing window, `persistWindowMs`),
   *    floored by the snapshot's BASE floor (`RegistryEntry.baseFloors`): the
   *    row's position only ever LOWERS to it (`LEAST`), and `position_at` /
   *    `tables_read` are kept; a missing row is inserted with the floor and
   *    `meta.guardTables` (the entry's route tables, or its read-set union).
   *
   * Both write `meta.definition` (A18). `meta.guardTables` is what the A6
   * produced-table guard judges in either mode. server:
   * `INSERT … ON CONFLICT (resource_key, params_key) DO UPDATE`.
   */
  persistSnapshot?: (
    key: string,
    paramsKey: string,
    value: unknown,
    watermark: string,
    meta: PersistMeta,
  ) => Promise<void>;
  /**
   * The trailing window (ms) a persisted alias's scoped changes coalesce in
   * before ONE floor persist of its reconstructed value (see `persistSnapshot`).
   * Default 2000. A test passes 0.
   */
  persistWindowMs?: number;
}

/** How one L2 persist writes its row — see `ResourceRuntimeOptions.persistSnapshot`. */
export interface PersistMeta {
  mode: "replace" | "floor";
  /** The entry's L2 definition (its routed plan's `definition`), NULL when it has none. */
  definition: string | null;
  /**
   * The tables the A6 guard judges: in `replace` mode the run's read-set
   * (written as `tables_read`); in `floor` mode the entry's route tables or
   * read-set union (written only when the row is inserted).
   */
  guardTables: readonly string[];
}

/** One table a routed resource's delivery depends on (see `scopedResourceTables`). */
export interface ScopedResourceTable {
  key: string;
  table: string;
  /** The route that names it: `route "<id>"`. */
  via: `route "${string}"`;
}

/**
 * One resource key's notify provenance (the `_debug` payload's `notifyStats`):
 * hand-`notify()` calls, change-feed deliveries, and in-process change-producer
 * deliveries (`TableChange.source`). Monotonic for the process lifetime.
 */
export interface NotifyCounts {
  hand: number;
  feed: number;
  producer: number;
}

/**
 * How a change reaches one entry (the `_debug` payload's `policy`; A7, D40) —
 * a closed set: a deferred placeholder not bound yet, truth outside Postgres,
 * compiler-emitted routes, or the legacy router's FULL recompute.
 */
type DebugPolicy = "unbound" | "external" | "routed" | "legacy-full";

export interface ResourceRuntime {
  /**
   * Declare a DB-backed resource. Two shapes:
   *
   * - Flat `(def)` — the strict `DefineResourceInput`, which is
   *   **push/invalidate-only**: a `mode: "keyed"` flat resource is unrepresentable.
   *   Keyed-ness can only be declared via the two-arg form below.
   * - Two-arg `(contract, serverOpts)` — derives `key`/`schema`/keyed-ness from
   *   the shared client descriptor so server and client can't drift. A KEYED
   *   contract requires a `ScopePolicy` in `serverOpts` (the scope-coverage
   *   invariant lives entirely here — there is no flat keyed form to skip it);
   *   a non-keyed contract takes `ServerResourceOptions`, whose `mode` is
   *   required.
   *
   * Prefer the two-arg form whenever a client descriptor exists for the resource.
   */
  defineResource: {
    <T, P extends ResourceParams = ResourceParams>(
      def: DefineResourceInput<T, P>,
    ): Resource<T, P>;
    <T, P extends ResourceParams = ResourceParams>(
      contract: KeyedResourceContract<T, P>,
      opts: KeyedServerResourceOptions<T, P> & ScopePolicy<P>,
    ): Resource<T, P>;
    <T, P extends ResourceParams = ResourceParams>(
      contract: ResourceContract<T, P> & { keyed?: never },
      opts: ServerResourceOptions<T, P>,
    ): Resource<T, P>;
  };
  /**
   * A resource whose server half is compiled at boot, once contributions are
   * collected (`bindDeferredResources`): its identity (key, mode, schema,
   * keyed-ness, preload) is the contract's and exists at module eval, so
   * `Resource.Declare` and the boot snapshot see it; `bind` returns the server
   * options, checked exactly as `defineResource`'s two-arg form checks them. A
   * non-keyed deferred resource is a push value. Serving it before it is bound
   * throws, and so does defining one after the bind ran.
   */
  defineDeferredResource: {
    <T, P extends ResourceParams = ResourceParams>(
      contract: KeyedResourceContract<T, P>,
      bind: () => KeyedServerResourceOptions<T, P> & ScopePolicy<P>,
    ): Resource<T, P>;
    <T, P extends ResourceParams = ResourceParams>(
      contract: ResourceContract<T, P> & { keyed?: never },
      bind: () => ServerResourceOptions<T, P>,
    ): Resource<T, P>;
  };
  /**
   * Bind every deferred resource (`defineDeferredResource`): compile its server
   * half and give its entry a loader, scope policy and routes. Once, in the boot
   * sequence, after contributions are collected and before anything serves.
   */
  bindDeferredResources: () => void;
  /**
   * Like `defineResource`, but the returned handle exposes a callable `notify()`.
   * For escape-hatch resources whose truth lives outside Postgres (the DB
   * change-feed can never reach them). Sets `entry.externalSource = true` for the
   * backstop check + `_debug` payload. See
   * research/2026-06-20-global-remove-hand-notify-dependson.md §2.
   *
   * Three shapes, mirroring `defineResource`:
   *
   * - Flat `(def)` — the loose `ResourceDefinition`, push / invalidate only.
   * - Two-arg `(contract, serverOpts)` — derives `key`/`schema` AND `preload`
   *   from the shared client descriptor so server and client can't drift,
   *   exactly like `defineResource`'s non-keyed two-arg form.
   * - Two-arg `(keyedContract, opts & ExternalWindowPolicy)` — a keyed
   *   bounded window (`ExternalWindowPolicy`): `notify(params)` re-reads the
   *   tuple and ships its keyed diff, and a sub may be seeded from tuples of
   *   the same family.
   *
   * Never ROUTED (D31): an external resource's truth is outside Postgres, so
   * no table change routes into it — its own `notify` is how a change arrives.
   */
  defineExternalResource: {
    // No `optionalParams` on the flat form: the spelling rule must come from the
    // shared client descriptor (the two-arg form), or the client would key
    // tuples the server's echoes never match. No `routes` / `reach` either: an
    // external resource's truth is outside Postgres, so no table change may
    // route into it.
    <T, P extends ResourceParams = ResourceParams>(
      def: ExternalDefinition<T, P>,
    ): ExternalResource<T, P>;
    <T, P extends ResourceParams = ResourceParams>(
      contract: KeyedResourceContract<T, P>,
      opts: KeyedServerResourceOptions<T, P> & ExternalWindowPolicy<P>,
    ): ExternalResource<T, P>;
    <T, P extends ResourceParams = ResourceParams>(
      contract: ResourceContract<T, P> & { keyed?: never },
      opts: ServerResourceOptions<T, P> & { reach?: never },
    ): ExternalResource<T, P>;
  };
  notificationsWsHandler: WsHandler;
  handleResourceHttp: (
    req: Request,
    params: Record<string, string>,
  ) => Promise<Response>;
  withNotifyBatch: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * Load any registered resource by key, routing through the same `timedLoad`
   * path `handleSub` uses (schema parse + profiler span). Throws if the key is
   * not registered. The single right home for "load any registered resource"
   * — used by the boot-snapshot warm-up and snapshot handler so they hit the
   * identical loader the boot burst hits. See
   * research/2026-06-14-global-cold-load-instant-boot.md.
   */
  loadResourceByKey: (key: string, params?: ResourceParams) => Promise<unknown>;
  /**
   * Run one full first-subscribe lifecycle for a registered resource and return
   * its timing, then tear it back down. Mirrors `handleSub`'s 0→1 path
   * byte-for-byte — `onFirstSubscribe` then the loader read through the same
   * `getResourceValue` single-flight path — then invokes `onLastUnsubscribe` so
   * the subcount-0 invariants/eviction are restored and a subsequent cold call
   * recomputes. Generic (keyed only by string); the structural home for
   * "simulate one first-subscribe" used by the benchmark harness and future debug
   * tools. Throws on an unknown key (matches `loadResourceByKey`). The hooks fire
   * exactly once each (symmetric), so no dangling subscription/watcher is left.
   */
  measureSubscribeCycle: (
    key: string,
    params?: ResourceParams,
  ) => Promise<{ onFirstSubscribeMs: number; loaderMs: number }>;
  /**
   * Re-emit a registered resource to its current subscribers WITHOUT a DB change:
   * schedules a notify so the loader re-runs and the keyed diff comes back empty,
   * producing a real no-op push. Sibling to `loadResourceByKey`. If `params` is
   * omitted, fans out to every distinct currently-subscribed params tuple for the
   * key. Returns the number of param-tuples scheduled (0 = no subscribers, so the
   * push is unobservable). Throws on an unknown key (fail loudly). Tagged
   * `source: "synthetic"` so it never pollutes the hand-vs-feed counters — the
   * deterministic-churn emitter for the live-state-churn debug pane.
   */
  triggerResourcePush: (key: string, params?: ResourceParams) => number;
  /**
   * Route one DB change (from the L4 change-feed) to every LEGACY (non-routed)
   * entry whose read-set reaches `table` through its relation bases: a FULL
   * recompute of each of its tracked tuples (param-less → `{}`), through
   * `scheduleNotify` tagged with the change's `source`. It carries no ids, op or
   * origin: a legacy entry has no scope to apply them to. DB-agnostic and
   * defensive: an unread table is a no-op, and it never throws. See
   * research/2026-10-08-global-scoped-change-routing-p8-steps-23-24.md (D36).
   */
  applyLegacyFullChange: (change: {
    /** The base table that changed. */
    table: string;
    /** Which producer made the change (see `TableChange.source`). */
    source: ChangeSource;
    /** Source transaction id (xid8 text) — mutation-ack attribution (`ackTx`). */
    xid?: string;
    /** Wall-clock epoch ms of the change (live NOTIFY only; see `PendingNotify.changedAt`). */
    changedAt?: number;
  }) => void;
  /**
   * Route one base-table change to the ROUTED entries (those declaring `routes`)
   * that read the table: per subscribed tuple, only the route occurrences that
   * tuple's `usesOf` names, mapped to host ids by each route's `HostMap` — so a
   * side-table write costs O(changed) and reaches only the tuples whose query
   * reads that table. A tuple the change skips owes at most an ack. Synchronous,
   * SQL-free and producer-agnostic (every producer calls it; reverse routes
   * resolve later, in the drain). Never throws. Entries without routes are served
   * by `applyLegacyFullChange` instead — each entry is reached by exactly one of the two.
   * See research/2026-09-29-global-scoped-change-routing.md.
   */
  routeTableChange: (change: TableChange) => void;
  /**
   * Force a FULL recompute of a single registered resource by key (param-less →
   * key `{}`), routed through the SAME cascade the feed uses (`source: "feed"`).
   * Used by the L2 boot init to recompute resources that have no usable persisted
   * read-set yet (first boot / newly-added / one-time migration), which persists
   * the value AND populates its read-set for the next boot. A no-op if the key is
   * not registered.
   */
  recomputeResource: (key: string) => void;
  /**
   * Self-verification counters for the `_debug` endpoint: how many notifies for
   * this resource key came from hand-`notify()` (`hand`), the DB change-feed
   * (`feed`) and an in-process change producer (`producer`). Used by the
   * read-set debug pane to surface read-set-gap candidates.
   */
  notifyStatsFor: (key: string) => NotifyCounts;
  /**
   * Occupancy of the read-admission gate (see `READ_LOAD_CONCURRENCY`):
   * currently-held slots, queued waiters, and the cap. The runtime stays
   * profiler-free, so the facade (server-core) registers this as the
   * `read-admit` gate gauge; central omits the registration.
   */
  readGateStats: () => { active: number; queued: number; max: number };
  /**
   * Every table a registered resource's routed delivery depends on: one row per
   * route of a ROUTED entry (`routes` / `reach` — every table it may read, since
   * only a change to one of them can reach it); a legacy entry, reached through
   * its read-set, has none. The change-feed cross-checks these against the tables it installed
   * triggers on at boot (A1): a table with no trigger can NEVER produce the
   * change the resource waits for, so the declaration is dead config that
   * silently degrades the resource to hydrate-on-mount with zero signal. The
   * runtime owns the registry; the change-feed owns the trigger set — this
   * accessor is the seam that lets the change-feed (the DB↔live-state wirer)
   * enforce the invariant without the runtime importing a specific DB plugin.
   */
  scopedResourceTables: () => ScopedResourceTable[];
  /**
   * The change-feed trigger layout every ROUTED table needs, derived from the
   * routes of every bound routed entry (`tableLayoutRequirements`): the key
   * columns a table's changes must carry, and the columns an UPDATE's `changed`
   * set is computed over. A table no route names is absent — its trigger keeps
   * the PK-only layout. Read once by the change feed when it rebuilds triggers
   * (after deferred resources are bound, before the ready barrier).
   */
  routedTableRequirements: () => TableLayoutRequirement[];
  /**
   * Every registered resource whose definition is BOUNDED-membership (a bounded
   * `membership: { kind: "window" }` or `{ kind: "point" }`) — the exact set the
   * L2 persist gate (`!membershipBounded`) excludes. The unbounded-window
   * `scopedMembership` alias is NOT bounded, so it is omitted (it keeps
   * persistence). Read straight off the registry's normalized membership record,
   * so it is the same definition-derived predicate the persist gate uses — never
   * a resource-name list. The `live-state-snapshot` boot sweep consumes it to
   * DELETE any leftover persisted rows for a key that USED to persist before it
   * was migrated to the bounded contract (a stale unbounded value would otherwise
   * be served via the L2 boot fast path).
   */
  boundedMembershipKeys: () => string[];
  /**
   * Every registered resource L2 persists right now — the runtime's own persist
   * gate (`isPersisted`: DB-backed, not bounded-membership, and admitted by the
   * injected `shouldPersist`), evaluated per entry, never a resource-name list.
   * `live-state-snapshot` reads it after installing its hooks, to refuse a
   * persisted reader of a table whose change source is volatile (A6).
   */
  persistedKeys: () => string[];
  /**
   * Every registered UNBOUNDED-window (`scopedMembership` alias) key — the only
   * membership shape L2-persisted and reconstructed from its per-pk snapshot bytes.
   * Symmetric to `boundedMembershipKeys` (which is the complementary bounded set):
   * read straight off the registry's normalized membership record, never a
   * resource-name list. `live-state-snapshot`'s boot seed consumes it to pick the
   * keys whose durable L2 value should reconstruct the in-memory diff base.
   */
  unboundedWindowKeys: () => string[];
  /**
   * Every registered resource that declared `preload` (`"boot"` /
   * `"boot-and-keep"`), as its key. The runtime never acts on the flag: the boot
   * snapshot and the L2 persist set read it off the facade's `Resource.Declare`
   * contributions instead. This is the registry's half of that pairing — the
   * server facade's boot assert compares the two, so a preloaded resource that
   * was registered but never declared fails boot instead of silently losing its
   * hydration and persistence.
   */
  preloadedKeys: () => string[];
  /**
   * Seed the in-memory diff base (`entry.snapshots` + order sigs) of a persisted
   * unbounded-window alias from its durable L2 value at boot, BEFORE catch-up, so
   * the first post-boot change is a scoped refill instead of a FULL O(collection)
   * rebuild. No-op unless the key is a registered unbounded-window alias with NO
   * snapshot yet for `paramsKey` — so it never clobbers a fresher sub-ack seed and
   * a wrong/unknown key is harmless (`skipped`). Mirrors the FULL rebuild's seeding
   * via the same `snapshotOf` primitive (byte-identical `retainSnapEncoder` entries).
   *
   * A30: the value is `safeParse`d against the entry's payload schema
   * (`z.array(row)`) first. A value that does not parse — a row schema changed
   * in a way the L2 definition does not fingerprint (an opaque transform body)
   * — seeds nothing and answers `invalid`: the caller treats the row as
   * missing (clear it, recompute the key), never as a diff base.
   */
  seedPersistedSnapshot: (
    key: string,
    paramsKey: string,
    value: unknown,
    base: PersistedBase,
  ) => SeedOutcome;
  /**
   * A30's parse on its own, seeding nothing: does this L2 value parse as the
   * payload of the registered unbounded-window alias `key`? `skipped` when
   * `key` is no such alias. `live-state-snapshot` runs it over every persisted
   * alias row in `onReadyBlocking` and clears the rows that fail, so the boot
   * snapshot's persisted fast path — open from readiness, before `onReady`'s
   * seed — never serves a value the entry's schema rejects.
   */
  validatePersistedValue: (key: string, value: unknown) => PersistedValueCheck;
  /**
   * The L2 definition (A18) of every persisted key that has one —
   * `persistedKeys()`'s twin. A row is usable only when its `definition`
   * equals this map's entry for its key (absent ⇒ NULL), so every L2 read
   * path (boot snapshot, boot seed, the usable check, catch-up's floor) passes
   * it as the expected map.
   */
  persistedDefinitions: () => Record<string, string>;
  /**
   * The current value of a persisted alias's param-less tuple, reconstructed
   * from its in-memory snapshot — fresher than its L2 row, which a floor
   * persist trails by up to `persistWindowMs`. Undefined when the key is not
   * a persisted alias or holds no snapshot yet (the boot snapshot then reads
   * L2, then the loader).
   */
  keptSnapshotValue: (key: string) => unknown[] | undefined;
  /**
   * Drop every armed floor window without writing it (shutdown): its changes
   * are in the changelog, and the row's floor still predates them, so the next
   * boot's catch-up replays them. Returns how many were dropped.
   */
  dropPendingPersists: () => number;
}

/** The L2 row a boot seed restores: its catch-up floor and when a replace last set it. */
export interface PersistedBase {
  /** The row's `position` — the seeded snapshot's base floor. */
  position: string;
  /** The row's `position_at` (epoch ms), or null when no replace ever wrote it. */
  positionAt: number | null;
}

/**
 * What `seedPersistedSnapshot` did with an L2 value: seeded the diff base;
 * skipped it (not a registered unbounded-window alias, or the tuple already
 * holds a fresher snapshot); or refused it because the value does not parse
 * as the entry's payload (A30) — the caller treats that row as missing.
 */
export type SeedOutcome =
  { kind: "seeded" } | { kind: "skipped" } | { kind: "invalid"; error: string };

/**
 * What `validatePersistedValue` found: the value parses as the alias's
 * payload; it does not (A30); or `key` is no registered unbounded-window alias.
 */
export type PersistedValueCheck =
  { kind: "valid" } | { kind: "skipped" } | { kind: "invalid"; error: string };

const HEARTBEAT_MS = 20_000;

// Read-admission concurrency cap. Bounds how many COLD read-path loads (WS
// sub-ack + HTTP GET fallback) — and the `revalidate` git/fs spawns they may run
// first — execute at once, so no fan-out (boot, a post-restart resubscribe herd,
// or the genuinely-dirty residual after conditional revalidation) can ever
// stampede more than N cold read-loads simultaneously. Orthogonal to the DB
// loader gate (that bounds DB connections; this bounds the whole read-path unit,
// including git/fs-only loaders that issue no query). The push/flush cascade is
// deliberately NOT gated here — it stays level-parallel, bounded by the DB gate.
// Tunable; surfaced via `get_runtime_profile`'s read-admit wait spans.
const READ_LOAD_CONCURRENCY = 6;

// A resource's `revalidate` may return ANY string — long, and with bytes
// (NUL/newline) that are illegal in an HTTP `ETag` header value and unstorable in
// Postgres text (a raw signature set as a header throws `TypeError: Header has
// invalid value`, escaping the handler as a 500). Normalize every signature into
// a compact, opaque, header-safe token by hashing it centrally here — so the
// token is identical across the WS and HTTP paths and every present/future
// resource is protected regardless of what its signature contains. The client
// treats the token as opaque, so hashing is transparent to comparison.
function normalizeEtag(raw: string): string {
  return createHash("sha1").update(raw).digest("hex");
}

// The most host ids one reverse route may resolve to in one flush before its
// reading tuples recompute FULL instead (a bounded window load, for a window).
// Handed to the route's own `resolve`, which answers "over-cap" past it.
const REVERSE_RESOLVE_CAP = 500;

// `paramsKey({})` — the one tuple of a param-less resource.
const EMPTY_PK = "{}";

export function createResourceRuntime(
  opts: ResourceRuntimeOptions = {},
): ResourceRuntime {
  const registry = new Map<string, RegistryEntry>();
  const inflight = createInflight();
  // The last tracking span handed out (see `RegistryEntry.spans`).
  let lastSpan = 0;
  // Per-runtime read-admission gate (see READ_LOAD_CONCURRENCY). Its `onWait`
  // charges queue-wait to the enclosing entry via the injected hook (server:
  // chargeWait), so a saturated gate is observable rather than hidden.
  const readLoadGate = createSemaphore(READ_LOAD_CONCURRENCY);
  const chargeReadGateWait = (waitMs: number): void =>
    opts.onReadGateWait?.(waitMs);
  // Identity of THIS server boot, stamped on every sub-ack / up-to-date frame.
  // `entry.versions` is per-boot in-memory state (created empty at registration,
  // bumped only in the flush paths — nothing restores it across restarts), so a
  // client-echoed version is comparable ONLY when the epochs match: same epoch +
  // same version ⇒ for a non-revalidate resource, no state change since the
  // client's value was produced — the per-pk version counter is its complete
  // change signal. See the version short-circuit in `handleSub`.
  const bootEpoch = randomUUID();
  // Per-key count of version short-circuits (a sub answered `up-to-date` from
  // memory: zero loader runs, zero read-admission slots). Monotonic; surfaced in
  // the `_debug` payload next to notifyStats for live re-validation.
  const subShortCircuits = new Map<string, number>();
  function recordSubShortCircuit(key: string): void {
    subShortCircuits.set(key, (subShortCircuits.get(key) ?? 0) + 1);
    opts.onSubShortCircuit?.(key);
  }
  // Per-key count of stale-flight supersessions (a drain refused to join a read
  // flight that started before the notify it is draining, and started its own).
  // Monotonic; surfaced in the `_debug` payload beside `subShortCircuits`. This
  // is how we learn whether the pre-commit join the 2026-08-08 incident rode on
  // still happens in production — and is now refused rather than shipped.
  const staleFlightSupersedes = new Map<string, number>();
  function recordStaleFlightSupersede(key: string): void {
    staleFlightSupersedes.set(key, (staleFlightSupersedes.get(key) ?? 0) + 1);
    opts.onStaleFlightSupersede?.(key);
  }
  // Per-key seeded derivations (see `deriveSub`): subs answered from rows the
  // client already held (no load), and the ones that asked but fell back to a
  // load, by reason. Monotonic; surfaced in the `_debug` payload — a high
  // fallback count under one reason is where a paged read pays full loads.
  const derivedSubs = new Map<string, number>();
  const deriveFallbacks = new Map<string, Map<DeriveRefusal, number>>();
  function recordDeriveFallback(key: string, reason: DeriveRefusal): void {
    let byReason = deriveFallbacks.get(key);
    if (!byReason) deriveFallbacks.set(key, (byReason = new Map()));
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }
  let dagDirty = true;
  let topoOrder: RegistryEntry[] = [];
  // `topoOrder` grouped by longest-path depth. Each level's entries are mutually
  // independent (no intra-level edges), so a flush runs a level concurrently and
  // barriers between levels to preserve cascade-into-downstream ordering.
  let topoLevels: RegistryEntry[][] = [];
  const sockets = new Map<ServerWebSocket<WsData>, SocketState>();
  let flushScheduled = false;
  // Single-active-flush mutex. `flushRunning` ⇒ a flush is mid-await; a new
  // flush sets `flushAgain` instead of overlapping, and the live flush re-drains.
  let flushRunning = false;
  let flushAgain = false;
  // `performance.now()` when the live flush last made progress — stamped when it
  // takes the mutex and re-stamped at the start of every re-drain pass; `null`
  // while no flush runs. The heartbeat reports its age as `flushOpenMs`. A flush
  // whose loader never settles (a DB query whose socket was closed underneath
  // it) holds the mutex forever, queueing every later push behind it while pings
  // keep flowing — so the ping is the one frame that can tell the tab pushes are
  // stuck. Per PASS, not per mutex hold: a steady notify stream keeps one hold
  // alive across many short, delivering passes, and that is not a stall.
  // research/2026-09-11-global-live-updates-frozen-by-stray-fd-close.md
  let flushPassStartedAt: number | null = null;
  function flushOpenMs(): number {
    return flushPassStartedAt === null
      ? 0
      : Math.round(performance.now() - flushPassStartedAt);
  }
  let batchDepth = 0;
  const heartbeats = new Map<
    ServerWebSocket<WsData>,
    ReturnType<typeof setInterval>
  >();

  // --- L4 self-verification (parallel-run instrumentation) ---
  // Per-resource-key notify counters, split by source (hand-`notify()` vs the DB
  // change-feed). The feed and hand-notify run together during the migration; a
  // hand-notify with no matching recent feed intent points at a table the L3
  // read-set capture missed (a read-set-gap candidate). Cleared never — these are
  // monotonic, surfaced in the `_debug` payload.
  //
  // A `producer` delivery (an in-process change producer, `TableChange.source`)
  // is counted on its own: it is a real change, but not a feed intent — the
  // read-set-gap match asks whether the FEED covered a hand-notified change.
  interface NotifyStats extends NotifyCounts {
    lastHandAt: number;
    lastFeedAt: number;
  }
  const notifyStats = new Map<string, NotifyStats>();
  function statsFor(key: string): NotifyStats {
    let s = notifyStats.get(key);
    if (!s) {
      s = { hand: 0, feed: 0, producer: 0, lastHandAt: 0, lastFeedAt: 0 };
      notifyStats.set(key, s);
    }
    return s;
  }
  // Ring buffer of recent feed intents `(resourceKey, pk, t)`. A hand-notify
  // checks this window to decide whether the feed already covered the same change.
  const FEED_RING_CAP = 256;
  const FEED_MATCH_WINDOW_MS = 2000;
  const feedRing: Array<{ key: string; pk: string; t: number }> = [];
  let feedRingHead = 0;
  function recordFeedIntent(key: string, pk: string, t: number): void {
    if (feedRing.length < FEED_RING_CAP) {
      feedRing.push({ key, pk, t });
    } else {
      feedRing[feedRingHead] = { key, pk, t };
      feedRingHead = (feedRingHead + 1) % FEED_RING_CAP;
    }
  }
  // One feed delivery to (key, pk) — a pending or an owed ack: the hand-vs-feed
  // counters plus the intent a later hand-notify is matched against.
  function countFeed(key: string, pk: string): void {
    const now = performance.now();
    const stats = statsFor(key);
    stats.feed++;
    stats.lastFeedAt = now;
    recordFeedIntent(key, pk, now);
  }
  function hasRecentFeedIntent(key: string, pk: string, now: number): boolean {
    for (const e of feedRing) {
      if (e.key === key && e.pk === pk && now - e.t <= FEED_MATCH_WINDOW_MS) {
        return true;
      }
    }
    return false;
  }

  // Memoized `table → resourceKey[]` inverse of the L3 read-set hook — the legacy
  // router's index. Keyed on the read-set sink's version counter (it moves on
  // every table gained, seeded or removed) plus the registry size (a new entry),
  // so a removal that happens to keep the total size cannot serve a stale
  // inversion, and a hit costs nothing per change. With no counter injected the
  // inversion is rebuilt on every change. ROUTED entries are skipped: they are
  // served by `routeTableChange`, so each change reaches each entry exactly once.
  //
  // The inversion is in BASE-table space: each read-set relation is indexed
  // under its relation bases (`opts.relationBases`, identity when absent), and
  // installing those bases moves the read-set version too (server-core's
  // `setRelationBases`), so the memo can never serve an inversion built
  // through older bases.
  const relationBasesOf =
    opts.relationBases ?? ((relation: string): readonly string[] => [relation]);
  let tableToResourcesCache: Map<string, string[]> | null = null;
  let tableToResourcesSig: string | null = null;
  // The relation bases of `key`'s captured read-set, sorted and distinct: each
  // relation the loader read expanded to its bases (a view or rollup to the
  // tables that feed it). Identity on central and in the DB-free harness.
  function readSetBasesOf(key: string): string[] {
    const bases = new Set<string>();
    for (const relation of opts.readSet?.(key) ?? []) {
      for (const base of relationBasesOf(relation)) bases.add(base);
    }
    return [...bases].sort();
  }
  // Does the legacy router (`applyLegacyFullChange`) index this entry under its
  // read-set bases? Every entry that is not routed — external entries and
  // unbound deferred placeholders included: a routed entry is reached only
  // through `routeTableChange`. The ONE predicate `tableToResources` and
  // `_debug`'s `legacyReach` both read, so the pane cannot disagree with the
  // router about who a base write reaches.
  function legacyRouted(entry: RegistryEntry): boolean {
    return !entry.routing;
  }
  function tableToResources(): Map<string, string[]> {
    const version = opts.readSetVersion?.();
    const sig =
      version === undefined ? null : `${registry.size}:${String(version)}`;
    if (tableToResourcesCache && sig !== null && sig === tableToResourcesSig) {
      return tableToResourcesCache;
    }
    const inverse = new Map<string, string[]>();
    for (const entry of registry.values()) {
      if (!legacyRouted(entry)) continue;
      // Two relations sharing a base list the entry under it once, so one
      // change is one notify per tuple.
      for (const base of readSetBasesOf(entry.key)) {
        const list = inverse.get(base);
        if (list) list.push(entry.key);
        else inverse.set(base, [entry.key]);
      }
    }
    tableToResourcesCache = inverse;
    tableToResourcesSig = sig;
    return inverse;
  }

  // The routed entries reading each table — the router's static index, filled at
  // `createResource` (routes are fixed at registration, so it never needs a memo).
  const routedByTable = new Map<string, RegistryEntry[]>();

  // console.error ALWAYS fires here; the report hook is additive. A
  // `ResourceRefusal` is not a failure of the server — the reader asked a
  // question that cannot be answered as asked, and is told so (`refused`) —
  // so it is logged, never reported.
  function reportLoaderError(context: string, err: unknown): void {
    if (err instanceof ResourceRefusal) {
      console.info(
        `[resources] ${context}: refused (${err.code}) — ${err.message}`,
      );
      return;
    }
    console.error(`[resources] ${context}`, err);
    opts.reportError?.(context, err);
  }

  // A tuple's canonical params for `entry` — the shared rule
  // (`canonicalParams`: an `undefined` value dropped, and a `""` for a
  // declared-optional param — see `ResourceDefinition.optionalParams`), the
  // SAME function the browser applies, so the tuple this runtime echoes is the
  // one the client keyed. Applied where params ENTER the runtime, so every later
  // step — `paramsKey`, the loader, subscriber routing — sees one spelling.
  function canonicalTuple(
    entry: Pick<RegistryEntry, "optionalParams">,
    params: ResourceParams,
  ): ResourceParams {
    return canonicalParams(params, entry.optionalParams);
  }

  /**
   * `canonicalTuple` for a frame's key, when the key is registered. A frame whose
   * params were not already canonical is reported once per key: the frames sent
   * back echo the canonical tuple, which that sender's own keying cannot match.
   */
  const nonCanonicalReported = new Set<string>();
  function canonicalFor(
    key: string | undefined,
    params: ResourceParams | undefined,
  ): ResourceParams | undefined {
    if (key === undefined || params === null || typeof params !== "object") {
      return params;
    }
    const entry = registry.get(key);
    if (!entry) return params;
    const canonical = canonicalTuple(entry, params);
    if (canonical !== params && !nonCanonicalReported.has(key)) {
      nonCanonicalReported.add(key);
      reportLoaderError(
        `non-canonical params for ${key}`,
        new Error(
          `a client subscribed ${JSON.stringify(params)}; the runtime keys (and echoes) ${JSON.stringify(canonical)} — canonicalize with canonicalParams before sending`,
        ),
      );
    }
    return canonical;
  }

  // ── Contract mismatch (see `ResourceContract.validateParams`) ──────────
  // A subscription whose params do not match its declaration is, after a
  // deploy, almost always a tab still running the previous bundle: expected,
  // and fixed by a reload. So the gate refuses it before it registers, and the
  // verdict decides whether anyone is told: `skew` only warns; `same-build` /
  // `unknown` report, because a current client failing decode is a real bug.

  /** Judge a mismatch against the client's build and apply the reporting policy. */
  function rejectContract(
    key: string,
    params: ResourceParams,
    err: ResourceContractError,
    clientBuild: string | undefined,
  ): ContractVerdict {
    const verdict = contractVerdict(
      clientBuild,
      opts.serverBuildGraph?.() ?? null,
    );
    if (verdict === "skew") {
      console.warn(
        `[resources] contract mismatch (skew) for ${key} params=${paramsKey(params)}: ${err.message}`,
      );
    } else {
      reportLoaderError(`contract mismatch (${verdict}) for ${key}`, err);
    }
    return verdict;
  }

  /**
   * The verdict an unknown key carries: a key the server no longer (or does
   * not yet) serve is the other face of skew. Never reported — a client naming
   * a key is not a server fault.
   */
  function unknownKeyVerdict(clientBuild: string | undefined): ContractVerdict {
    return contractVerdict(clientBuild, opts.serverBuildGraph?.() ?? null);
  }

  /**
   * Run `entry`'s params gate for a WS sub. On a refusal it sends the
   * `sub-error` itself and returns true; the caller must then neither
   * authorize, register nor load. A gate that throws something other than
   * `ResourceContractError` is a bug in the gate: reported, refused as
   * `loader-failed`.
   */
  function refuseSubParams(
    ws: ServerWebSocket<WsData>,
    entry: RegistryEntry,
    id: number | undefined,
    params: ResourceParams,
    clientBuild: string | undefined,
  ): boolean {
    try {
      entry.validateParams(params);
      return false;
    } catch (err) {
      if (err instanceof ResourceContractError) {
        const verdict = rejectContract(entry.key, params, err, clientBuild);
        sendJson(ws, {
          kind: "sub-error",
          id,
          key: entry.key,
          params,
          reason: "contract-mismatch",
          verdict,
        });
      } else {
        reportLoaderError(`validateParams failed for ${entry.key}`, err);
        sendJson(ws, {
          kind: "sub-error",
          id,
          key: entry.key,
          params,
          reason: "loader-failed",
        });
      }
      return true;
    }
  }

  /**
   * The backstop for a gate gap: a REGISTERED tuple whose loader (or window /
   * point decode) threw `ResourceContractError` — the gate let through params
   * the loader refuses. Left registered, every push would rerun it and fail
   * again, so the tuple is dropped from every socket holding it, each holder
   * is told `contract-mismatch`, and it is ALWAYS reported (it is a bug in the
   * gate, whatever the client's build). Returns false for any other error, so
   * the caller's own failure handling runs.
   */
  function evictOnContractError(
    entry: RegistryEntry,
    params: ResourceParams,
    err: unknown,
  ): boolean {
    if (!(err instanceof ResourceContractError)) return false;
    reportLoaderError(
      `contract mismatch past the params gate for ${entry.key} (validateParams accepted params the loader refuses)`,
      err,
    );
    unregisterTupleEverywhere(entry.key, params, (state) =>
      sendJson(state.ws, {
        kind: "sub-error",
        key: entry.key,
        params,
        reason: "contract-mismatch",
        verdict: "unknown",
      }),
    );
    return true;
  }

  function paramsKey(params: ResourceParams): string {
    const keys = Object.keys(params).sort();
    const obj: ResourceParams = {};
    for (const k of keys) obj[k] = params[k]!;
    return JSON.stringify(obj);
  }

  // The read-set to persist alongside a FULL value: the tables the loader read on
  // its LAST run (authoritative + self-healing — sheds an edge a code change
  // removed or a historical mis-attribution left behind), falling back to the
  // accumulated union when the per-run capture is unavailable (central runtime, or
  // a scoped-membership persist whose cycle ran no loader). REPLACE semantics: the
  // persist SQL sets `tables_read = EXCLUDED`, so feeding it the per-run set here is
  // what makes the durable seed converge. The in-memory union (`opts.readSet`) is
  // deliberately left untouched — it stays an over-approximation so live
  // `applyLegacyFullChange` routing never under-delivers. Must be read SYNCHRONOUSLY right
  // after awaiting the loader; every persisted resource is param-less (single pk),
  // so no concurrent same-key run can clobber the per-run capture in between.
  function persistReadSet(key: string): string[] {
    return opts.lastReadSet?.(key) ?? opts.readSet?.(key) ?? [];
  }

  // Internal refill primitive — the ONLY place `entry.loader` runs. The loader
  // output is parsed against the resource's schema before it leaves this
  // function, so every load path (sub-ack, push/keyed/scoped notify, HTTP
  // fallback) is validated at one chokepoint — a schema violation throws here and
  // is handled by each caller's loader-failure path (report + skip the send).
  // Keyed Layer-2 scoped loads return a partial array, which still satisfies the
  // `z.array(Element)` schema. `wrapLoad` (server: recordEntrySpan) also
  // establishes the ambient parent context so DB queries issued inside the loader
  // attribute to it. Private to `getResourceValue` + the keyed reseed below; all
  // read call sites go through `getResourceValue`.
  function timedLoad(
    entry: RegistryEntry,
    params: ResourceParams,
    ctx?: { affectedIds: readonly string[] },
  ): Promise<unknown> {
    const run = async () =>
      entry.schema.parse(await declaredLoad(entry, params, ctx));
    let load: Promise<unknown>;
    if (opts.wrapLoad) {
      const info: LoadInfo = {};
      if (Object.keys(params).length > 0) info.variant = paramsKey(params);
      if (ctx) info.scopedIds = ctx.affectedIds.length;
      load = opts.wrapLoad(entry.key, info, run);
    } else {
      load = run();
    }
    return entry.routing && opts.lastReadSet
      ? load.then(checkRouteDrift(entry))
      : load;
  }

  // The loader, with one rule on what it may throw: a `ResourceRefusal` must
  // carry a code the resource declares (`ResourceDefinition.refusals`) — the
  // client types and checks the code against the same declaration. Any other
  // code is a server bug, so it becomes a plain failure here (`loader-failed`,
  // reported, the refusal as `cause`) and never reaches the wire as `refused`.
  async function declaredLoad(
    entry: RegistryEntry,
    params: ResourceParams,
    ctx?: { affectedIds: readonly string[] },
  ): Promise<unknown> {
    try {
      return await entry.loader(params, ctx);
    } catch (err) {
      if (
        err instanceof ResourceRefusal &&
        !(entry.refusals ?? []).includes(err.code)
      ) {
        throw new Error(
          `resource "${entry.key}": the loader refused with code "${err.code}", ` +
            `which the resource does not declare (refusals: ` +
            `${JSON.stringify(entry.refusals ?? [])}) — ${err.message}`,
          { cause: err },
        );
      }
      throw err;
    }
  }

  // A8 — the drift guard. A routed entry is reached ONLY through its routes, so a
  // table its loader reads that no route names is a table whose writes it never
  // sees: a stale value nothing would reveal. After each loader run, the key's
  // per-run capture (the read-set sink's, flushed when the wrapped load settles)
  // must be a subset of its route tables — plus its derived reads (A22): a
  // rollup no route may name (A1), whose every source the plan routes
  // (`mintRoutePlan` asserted it), so a write moving its rows reaches the entry.
  // A miss is reported once per table — or thrown, under `strictRoutes`
  // (tests). With no capture wired (central, the DB-free harness) the guard is
  // off; routing never depends on it.
  function checkRouteDrift(entry: RegistryEntry): (value: unknown) => unknown {
    return (value) => {
      const routing = entry.routing!;
      const unrouted = (opts.lastReadSet!(entry.key) ?? []).filter(
        (table) =>
          !routing.byTable.has(table) &&
          !routing.derived.has(table) &&
          !routing.drifted.has(table),
      );
      if (unrouted.length === 0) return value;
      const err = new Error(
        `routed resource "${entry.key}" read ${unrouted.map((t) => `"${t}"`).join(", ")}, which none of its routes names — a write there never reaches it. Its compiler must emit a route for every table the SQL reads.`,
      );
      if (opts.strictRoutes) throw err;
      for (const table of unrouted) routing.drifted.add(table);
      reportLoaderError(`route drift for ${entry.key}`, err);
      return value;
    };
  }

  // The one call site of a window's ids-only membership query. `wrapMembership`
  // (server: a `membership` entry span) keeps it apart from the value query in
  // the profiler, and out of the loader read-set index.
  function runWindowIds(
    entry: RegistryEntry,
    membership: Extract<MembershipRecord, { kind: "window" }>,
    params: ResourceParams,
  ): Promise<string[]> {
    const run = () => membership.windowIdsOf(params);
    return opts.wrapMembership ? opts.wrapMembership(entry.key, run) : run();
  }

  // The single read accessor. Full loads (ctx === undefined: sub-ack, HTTP
  // fallback, loadResourceByKey, plain notify-reload) share ONE in-flight loader
  // promise per (key, params), collapsing the multi-tab / GET-races-sub herd. The
  // shared parsed value is treated as IMMUTABLE by every coalesced caller (all
  // current consumers are read-only). inflight clears the key the instant the
  // promise settles, so the next load is fresh — error/staleness sharing is safe.
  // Single-flight wraps OUTSIDE the loader semaphore (the semaphore lives in
  // wrapLoad, inside timedLoad) so a deduped caller never consumes a gate slot.
  //
  // Scoped keyed-delta loads (ctx.affectedIds, Layer 2) return a PARTIAL array and
  // NEVER coalesce: a plain subscriber must not attach to a partial load (torn
  // snapshot), and two scoped loads with different affectedIds are not the same
  // work. They run the refill directly, and never carry an ETag — a partial value
  // is not a snapshot any signature describes.
  //
  // THE VALUE AND ITS ETAG ARE CO-PRODUCED BY ONE FLIGHT. `seedEtag` is the
  // signature the CALLER probed before asking for the value; the resolved `etag`
  // is the signature the flight that actually produced the value was seeded with.
  // For the STARTER they are the same string. For a JOINER they differ: joiners
  // receive the starter's object and therefore **adopt the starter's seed,
  // discarding their own**. That discard is the whole point.
  //
  // Without it: two `handleSub`s probe their own signatures either side of a
  // change (starter reads S1, joiner reads S2), coalesce onto ONE loader run whose
  // value is the S1 snapshot, and the joiner stamps `(V@S1, S2)` on its sub-ack.
  // Its next revalidation sends S2, the server recomputes S2 from unchanged state
  // and answers `up-to-date`/`304` — and for an `invalidate`-mode resource, whose
  // pushes carry no value, nothing ever heals it. The client holds the stale value
  // FOREVER. Adopting the starter's older seed inverts the error into the safe
  // direction: an ETag describing a snapshot older than its value costs one
  // needless recompute on the next revalidation, and can never serve stale.
  //
  // A flight started by a caller with no seed (push path, `loadResourceByKey`)
  // resolves `etag: undefined`, and every joiner adopts that too — see `handleSub`.
  //
  // THE WATERMARK IS CO-PRODUCED BY THE SAME FLIGHT (Rule B′ — the causal twin of
  // the etag co-production above). The STARTER captures the commit watermark
  // (`opts.captureWatermark`, xid8 xmin) BEFORE `timedLoad`, so it is a valid
  // floor for the value the flight produces: any commit invisible to the loader's
  // snapshot has xid >= it (Rule B). Joiners adopt the starter's whole
  // `{value, etag, watermark}` — a watermark newer than the value it rides with
  // is structurally excluded, exactly like the etag seed adoption. No hook
  // (central runtime) or a throwing hook ⇒ `undefined`: the frame ships
  // tokenless and the optimistic client degrades to content-only confirmation —
  // never a wrong causal denial. A SCOPED load (ctx) is a partial re-read of
  // only the affected rows, so it NEVER carries a watermark: stamping one would
  // let a client treat a partial value as full server truth at that floor.
  // THE ackTx IS CO-PRODUCED BY THE SAME FLIGHT (the third co-production, after
  // the etag and the watermark). `seedAckTx` is the pending's source-transaction
  // ids the CALLER (a feed-driven drain) wants stamped on the frames this value
  // feeds; the resolved `ackTx` is the seed of the flight that ACTUALLY produced
  // the value. A caller that JOINS a flight adopts the starter's (typically
  // undefined) seed and ships NO ackTx — a missed ack degrades to the client's
  // watermark backstop, while stamping its own seed on someone else's value
  // would be a FALSE ack (the one soundness hazard the co-production closes).
  // The FULL drains additionally pass `notBefore` (below), so they no longer
  // join a pre-commit flight at all and in practice stamp their own set.
  // Read-path callers (sub-ack / HTTP / loadResourceByKey) never seed and never
  // stamp ackTx (their snapshot watermark subsumes it). A SCOPED (ctx) load
  // never coalesces (ctx loads bypass the inflight), so returning the seed
  // directly is safe.
  //
  // THE VERSION IS *NOT* CO-PRODUCED — WHICH IS WHY `notBefore` EXISTS. A push
  // drain assigns `version = current + 1` BEFORE it asks for the value, and that
  // number is an assertion: "this is the state as of the change I am draining".
  // Nothing about joining a flight can make an older SELECT satisfy it — so the
  // defence cannot be adoption, it has to be REFUSAL. `notBefore` is the caller's
  // freshness floor (the drain passes `pendingEntry.lastNotifyAt`): a flight that
  // STARTED before it is superseded rather than joined, and this call starts its
  // own. Passing nothing keeps the plain deduplicator, which is what every READ
  // caller wants — a read frame only ever *reports* a version it observed before
  // the load, so a joined older value can only report an older version, which the
  // client already drops. Never key this off `gated`: the boot-snapshot fan-out
  // and the multi-tab sub herd are read callers that MUST keep coalescing.
  // Without it, the 2026-08-08 incident: a drain joined a flight whose SELECT
  // predated the very commit that triggered it, and broadcast the pre-commit
  // rows at the fresh version. The client's only guard is numeric, so it applied
  // them — and since the pending had already been cleared, nothing re-read.
  // See research/2026-08-08-global-live-state-flight-freshness.md.
  //
  // THE BASE VERSION IS CO-PRODUCED TOO (the fourth): the tuple's version when
  // the flight's read STARTED, read in the starter's factory. A sub-ack re-seeds
  // the keyed snapshot only while the version still equals it — i.e. no push
  // advanced the snapshot since this value's read began. The version the
  // caller observed itself is not enough: a subscriber that joins a flight
  // started before a push observes the pushed version and would re-seed the
  // snapshot from the older read.
  async function getResourceValue(
    entry: RegistryEntry,
    params: ResourceParams,
    ctx?: { affectedIds: readonly string[] },
    seedEtag?: string,
    gated = false,
    seedAckTx?: readonly string[],
    notBefore?: number,
  ): Promise<FlightValue> {
    if (ctx) {
      // A scoped load bypasses the inflight entirely, so it can never join
      // anything and `notBefore` has nothing to refuse — ignored, not forgotten.
      const baseVersion = entry.versions.get(paramsKey(params)) ?? 0;
      return {
        value: await timedLoad(entry, params, ctx),
        etag: undefined,
        watermark: undefined,
        ackTx: seedAckTx,
        baseVersion,
      };
    }
    // Gate-after-dedup: when `gated` (the read path), the read-admission slot is
    // acquired INSIDE the single-flight factory, so only the STARTER of a flight
    // ever occupies a slot — N replayed subs of one (key, params) consume 1 slot,
    // not N (the "joiners burn read-admit slots" convoy of
    // research/perfs/2026-07-11-compressor-thrash-subscription-replay-storm.md
    // Finding 3). Joiners ride the EXISTING `read-coalesce` wait
    // (`onCoalesceWait`), which now subsumes the flight's gate wait: a coalesced
    // caller's reported wait includes the starter's time queueing for a slot,
    // charged as coalesce-wait in the joiner's own context — never gate-wait
    // (only the starter runs `chargeReadGateWait`, in its own context, because
    // inflight runs the starter's factory synchronously in its call frame).
    // Push-path callers (`gated` false) start UNGATED flights exactly as before;
    // a gated read joining one rides the coalesce wait with no slot either way.
    // The flight factory: watermark capture FIRST (Rule B — the floor is valid
    // only if captured before the loader's first read), then the loader. Runs
    // only in the STARTER's frame; joiners coalesce onto the resolved object.
    const load = async (): Promise<FlightValue> => {
      // Read before any await: the version the value below is at least as new as.
      const baseVersion = entry.versions.get(paramsKey(params)) ?? 0;
      let watermark: string | undefined;
      if (opts.captureWatermark) {
        try {
          watermark = await opts.captureWatermark();
        } catch (err) {
          // Tokenless degrade — the value still ships; the client just cannot
          // causally deny against this frame. Loud via the report hook.
          reportLoaderError(`watermark capture failed for ${entry.key}`, err);
        }
      }
      // `ackTx: seedAckTx` — the STARTER's seed; joiners adopt it wholesale
      // (like the etag/watermark), so a stamped ackTx always describes the
      // flight that produced the value it rides with.
      return {
        value: await timedLoad(entry, params),
        etag: seedEtag,
        watermark,
        ackTx: seedAckTx,
        baseVersion,
      };
    };
    return inflight.run(
      `${entry.key} ${paramsKey(params)}`,
      gated
        ? () => readLoadGate.run(load, { onWait: chargeReadGateWait })
        : load,
      {
        onWait: opts.onCoalesceWait,
        // Undefined for every read caller ⇒ join any live flight, exactly as
        // before. Set only by the FULL drains, which cannot serve a value older
        // than the notify they are minting a version for.
        notBefore,
        onSupersede: () => recordStaleFlightSupersede(entry.key),
      },
    );
  }

  // Run a full loader on the READ path (WS sub-ack + HTTP GET fallback) inside a
  // `sub` origin so the loader span (and the charged gate/coalesce waits)
  // attribute to the subscribe that triggered it. The read-admission gate is
  // applied INSIDE the single-flight (see `getResourceValue`): dedup happens
  // BEFORE admission, so N concurrent reads of one (key, params) consume ONE
  // slot. An earlier version admitted before the dedup on the theory that herd
  // keys are distinct (one per conversation); the 2026-07-11 replay-storm
  // forensics refuted that — chronic full-set sub replays hit the SAME pks from
  // every tab, and each joiner burning a slot behind slow git loaders built the
  // 5,242-deep sub convoy at 9.8s average wait. See
  // research/perfs/2026-07-11-compressor-thrash-subscription-replay-storm.md
  // Finding 3. The push/flush cascade stays ungated (bounded by the DB gate).
  //
  // `seedEtag` is the caller's freshly-probed signature, offered to the flight this
  // call may START. The returned `etag` is the one the flight was actually seeded
  // with — the caller's own iff it started the flight. Callers must stamp the
  // RETURNED etag, never their own (see `getResourceValue`).
  function gatedRead(
    entry: RegistryEntry,
    params: ResourceParams,
    seedEtag?: string,
  ): Promise<FlightValue> {
    // No ackTx seed and the resolved ackTx is discarded: read-path frames
    // (sub-ack / HTTP body) never carry one — their snapshot watermark subsumes
    // it (Rule B).
    const run = () =>
      getResourceValue(entry, params, undefined, seedEtag, true);
    return opts.wrapOrigin ? opts.wrapOrigin("sub", entry.key, run) : run();
  }

  // Compute a resource's conditional-revalidation ETag under the SAME gate + `sub`
  // origin as a read-path load (the signature may spawn git/fs). Returns undefined
  // when the resource never opted in OR the signature threw — a fail-safe: the
  // caller then falls through to the full loader / omits the ETag, so a broken
  // signature degrades to today's behavior and never serves stale.
  async function computeEtag(
    entry: RegistryEntry,
    params: ResourceParams,
  ): Promise<string | undefined> {
    if (!entry.revalidate) return undefined;
    const revalidate = entry.revalidate;
    try {
      const run = () =>
        readLoadGate.run(() => revalidate(params), {
          onWait: chargeReadGateWait,
        });
      const raw = await (opts.wrapOrigin
        ? opts.wrapOrigin("sub", entry.key, run)
        : run());
      return normalizeEtag(raw);
      // eslint-disable-next-line promise-safety/no-absorbed-failure -- the loader error IS reported (reportLoaderError); returning undefined skips this push so the live-state sub retains its last-good value (documented stale-safe behavior), never publishing a false empty
    } catch (err) {
      reportLoaderError(`revalidate failed for ${entry.key}`, err);
      return undefined;
    }
  }

  // Compute an ETag on the PUSH/flush path — UNGATED (the cascade is level-
  // parallel, bounded by the DB gate, never the read-admission cap) and
  // attributed to the `push` origin. Rides an `update` frame so the client's
  // stored ETag stays fresh after a push (else its next resubscribe would send a
  // stale ETag and needlessly recompute). Fail-safe: undefined on opt-out or a
  // throwing signature — the frame then omits the ETag and the client keeps its
  // last stored one.
  //
  // ONLY sendUpdate may call this.
  async function pushEtag(
    entry: RegistryEntry,
    params: ResourceParams,
  ): Promise<string | undefined> {
    if (!entry.revalidate) return undefined;
    const revalidate = entry.revalidate;
    try {
      const run = () => revalidate(params);
      const raw = await (opts.wrapOrigin
        ? opts.wrapOrigin("push", entry.key, run)
        : run());
      return normalizeEtag(raw);
      // eslint-disable-next-line promise-safety/no-absorbed-failure -- the loader error IS reported (reportLoaderError); returning undefined skips this push so the live-state sub retains its last-good value (documented stale-safe behavior), never publishing a false empty
    } catch (err) {
      reportLoaderError(`revalidate failed for ${entry.key}`, err);
      return undefined;
    }
  }

  // Build and broadcast a value-carrying `update` frame — the ONLY caller of
  // `pushEtag`, so an ETag can ride ONLY this frame. An ETag may accompany a frame
  // only if that frame CARRIES the value the ETag describes, so the etag is
  // computed here, at the one site that broadcasts a value-carrying `update`, and
  // nowhere else. The `invalidate` frame and every `delta` frame therefore cannot
  // compute one: not by convention, but because there is no other call site.
  // (Before this, both drain paths hoisted `pushEtag` above the frame-kind branch
  // and the non-`update` branches silently discarded it — for `edited-files` that
  // was a DB read + 3 git spawns + an lstat per dirty file thrown away on every
  // watcher notify.)
  //
  // A resource that never opted into `revalidate` builds AND sends its frame with
  // NO await anywhere on this path — it must not pay a microtask yield before the
  // frame reaches the wire. `runtime-h5.test.ts` H5a pins that a push beats a
  // racing parked sub-ack, and one extra tick before the `ws.send` flips that
  // order. Only the etag path awaits, and its `.then` broadcast lands the frame on
  // the wire in the same continuation the etag resolves in. (An earlier version
  // built the frame in a plain `async` helper and returned it to the caller to
  // send; `await`ing that helper deferred EVERY push-mode send by a tick — almost
  // no resource declares `revalidate` — and broke H5a. Sending inside keeps the
  // no-await property structural.)
  //
  // Unlike the read path (handleSub / handleResourceHttp), the etag-AFTER-value
  // order is SAFE here and deliberately not reordered: this frame CARRIES the
  // value, and any change landing between the value read and this etag read fires
  // its own notify → flushAgain → another drainEntry that ships a fresh value +
  // etag, so a momentarily skewed frame is always superseded (self-healing). The
  // read path has no such self-heal and must keep its etag-BEFORE-value ordering.
  // `watermark` is the flight-co-produced commit watermark for THIS value (Rule
  // B′ — a full value-carrying frame may carry one; see `getResourceValue`).
  // Passed by value, so the no-`revalidate` path keeps its no-await-before-send
  // property (H5a) untouched.
  // `ackTx` is the flight-resolved mutation-ack attribution (feed-driven
  // recomputes only — the read paths never pass one). Passed by value like
  // `watermark`, so the no-`revalidate` path keeps its no-await-before-send
  // property (H5a) untouched.
  function sendUpdate(
    entry: RegistryEntry,
    params: ResourceParams,
    value: unknown,
    version: number,
    subs: SocketState[],
    watermark?: string,
    ackTx?: readonly string[],
    changedAt?: number,
  ): number | Promise<number> {
    const broadcast = (etag?: string): number => {
      const msg = {
        kind: "update" as const,
        key: entry.key,
        params,
        value,
        version,
        ...(etag !== undefined ? { etag } : {}),
        ...(watermark !== undefined ? { watermark } : {}),
        ...(ackTx !== undefined && ackTx.length > 0 ? { ackTx } : {}),
        ...(changedAt !== undefined ? { changedAt } : {}),
      };
      return broadcastJson(subs, msg);
    };
    if (!entry.revalidate) {
      return broadcast(); // sync send — no microtask before the wire (H5a)
    }
    return pushEtag(entry, params).then(broadcast);
  }

  // Coalesce an incoming notify into the pending map for one pk, applying the
  // FULL-absorbing union: a null `incoming` (or an existing FULL) sticks the pk
  // at FULL; otherwise the incoming ids union into the existing scoped set.
  //
  // `deleted` (M5 `scopedMembership` only) is the op-D channel. It rides ALONGSIDE
  // a scoped `incoming` and follows the same rules — FULL absorbs it, a degrade to
  // FULL drops it, scoped∪scoped unions it:
  //
  //   existing | incoming | deleted | result
  //   none     | null     |   —     | FULL (no deleted)
  //   none     | Set A    | Set D   | copy both
  //   FULL     | anything | anything| unchanged (absorbs; drops incoming deleted)
  //   scoped   | null     |   —     | degrade FULL, drop deleted
  //   scoped   | Set A    | Set D   | union both
  //
  // Omitting `deleted` (every legacy caller) is byte-identical to the pre-M5 merge.
  // `unresolved` (routed entries: reverse routes still to resolve in the drain)
  // follows exactly the same rules as `deleted`.
  //
  // `sourceTx` (mutation-ack attribution) is unioned on EVERY branch — including
  // FULL absorb and the degrade-to-FULL — because a FULL recompute reads
  // post-commit, so the ackTx claim ("W's rows have been re-read") survives the
  // scope degrade. Contrast `deleted`, which FULL drops (a FULL recompute
  // resolves membership wholesale). Capped at SOURCE_TX_CAP: overflow suppresses
  // the whole set for the cycle (a missing ack is safe; a torn set is not).
  const SOURCE_TX_CAP = 64;
  function unionSourceTx(
    pending: PendingNotify,
    sourceTx?: ReadonlySet<string>,
  ): void {
    if (!sourceTx || sourceTx.size === 0 || pending.sourceTxOverflow) return;
    const set = (pending.sourceTx ??= new Set<string>());
    for (const id of sourceTx) set.add(id);
    if (set.size > SOURCE_TX_CAP) {
      pending.sourceTxOverflow = true;
      pending.sourceTx = undefined;
    }
  }
  function mergePending(
    map: Map<string, PendingNotify>,
    pk: string,
    params: ResourceParams,
    incoming: Set<string> | null,
    deleted?: Set<string>,
    sourceTx?: ReadonlySet<string>,
    changedAt?: number,
    unresolved?: readonly UnresolvedReverse[],
  ): void {
    const existing = map.get(pk);
    const now = performance.now();
    if (!existing) {
      // First merge: stamp the staleness-window start. Never overwritten below.
      // The freshness floor starts equal to it and moves with every later merge.
      const created: PendingNotify = {
        params,
        affected: incoming === null ? null : new Set(incoming),
        // A FULL first-merge carries no deleted set (FULL recomputes wholesale).
        ...(incoming !== null && deleted && deleted.size > 0
          ? { deleted: new Set(deleted) }
          : {}),
        enqueuedAt: now,
        lastNotifyAt: now,
        ...(changedAt !== undefined ? { changedAt } : {}),
      };
      if (incoming !== null) mergeUnresolved(created, unresolved);
      unionSourceTx(created, sourceTx);
      map.set(pk, created);
      return;
    }
    // FULL absorbs the scope but NOT the ack attribution — union first.
    unionSourceTx(existing, sourceTx);
    // …and NOT the freshness floor either. This MUST precede both early returns
    // below: a FULL-absorbing merge is the exact shape an `ids: null` change
    // takes (the 2026-08-08 incident's own shape), so a floor refreshed after
    // them would leave the drain joining a pre-commit flight in the most common
    // case of all — a FULL pending absorbing every later change for free.
    existing.lastNotifyAt = now;
    // Earliest change wins (see `PendingNotify.changedAt`); also before the early
    // returns, so a FULL-absorbing merge still keeps the oldest instant.
    if (
      changedAt !== undefined &&
      (existing.changedAt === undefined || changedAt < existing.changedAt)
    ) {
      existing.changedAt = changedAt;
    }
    if (existing.affected === null) return; // FULL absorbs everything (incl. deleted)
    if (incoming === null) {
      existing.affected = null; // degrade to FULL
      existing.deleted = undefined; // FULL recomputes wholesale — drop op-D ids
      existing.unresolved = undefined; // …and needs no host ids resolved
      return;
    }
    for (const id of incoming) existing.affected.add(id);
    if (deleted && deleted.size > 0) {
      const d = (existing.deleted ??= new Set<string>());
      for (const id of deleted) d.add(id);
    }
    mergeUnresolved(existing, unresolved);
  }

  // Union reverse routes awaiting resolution into a SCOPED pending, by route id.
  // `membership` is sticky: one contributor that cannot be bounded by the
  // tuple's members unbounds the whole resolution.
  function mergeUnresolved(
    pending: PendingNotify,
    unresolved: readonly UnresolvedReverse[] | undefined,
  ): void {
    if (!unresolved || unresolved.length === 0) return;
    const map = (pending.unresolved ??= new Map());
    for (const u of unresolved) {
      const existing = map.get(u.route.id);
      if (existing) {
        for (const v of u.changed) existing.changed.add(v);
        if (u.role === "membership") existing.membership = true;
      } else {
        map.set(u.route.id, {
          route: u.route,
          changed: new Set(u.changed),
          membership: u.role === "membership",
        });
      }
    }
  }

  // The pending's shippable ackTx: undefined when absent, empty, or overflowed
  // (suppression — see `PendingNotify.sourceTxOverflow`).
  function pendingAckTx(pending: PendingNotify): string[] | undefined {
    if (
      pending.sourceTxOverflow ||
      !pending.sourceTx ||
      pending.sourceTx.size === 0
    ) {
      return undefined;
    }
    return [...pending.sourceTx];
  }

  // The pending's sourceTx as threaded DOWNSTREAM through the cascade (a
  // downstream recompute reads post-commit too, so the claim propagates).
  // Overflow propagates as suppression (undefined).
  function cascadeSourceTx(
    pending: PendingNotify,
  ): ReadonlySet<string> | undefined {
    return pending.sourceTxOverflow ? undefined : pending.sourceTx;
  }

  // Broadcast a standalone `{ kind: "ack" }` frame for a recompute that produced
  // NO value change — gated on a non-empty (non-overflowed) sourceTx and on
  // subscribers that ASKED for acks on this tuple (`SocketSubRecord.ackTabs`).
  // Client-requested, not declared: a tuple nobody writes optimistically pays
  // nothing. Version-less and cache-less by design: it MUST NOT bump the per-pk
  // version counter, touch the snapshot, or cascade — it exists purely so an
  // optimistic client's exact-ack confirmation never hangs on a no-op recompute.
  function broadcastAckOnly(
    entry: RegistryEntry,
    pendingEntry: PendingNotify,
  ): number {
    return broadcastAck(entry, pendingEntry.params, pendingAckTx(pendingEntry));
  }
  function broadcastAck(
    entry: RegistryEntry,
    params: ResourceParams,
    ackTx: readonly string[] | undefined,
  ): number {
    if (ackTx === undefined || ackTx.length === 0) return 0;
    const subs = ackSubscribersFor(entry.key, paramsKey(params));
    if (subs.length === 0) return 0;
    return broadcastJson(subs, {
      kind: "ack" as const,
      key: entry.key,
      params,
      ackTx,
    });
  }

  // Validate and index a routed entry's plan (see `ResourceDefinition.routes` /
  // `.reach`). The types already refuse routes on an external resource, off a
  // membership arm, a reach on a keyed entry, a non-`full` reach route, either
  // beside a `dependsOn`, and an unminted plan; these
  // throws hold the same line for an untyped caller or an `as` cast.
  // A9: route ids must be unique within the resource — `usesOf` names routes by
  // id, so a duplicate would make a tuple's read-set ambiguous.
  function routingRecordFor(
    def: Pick<
      ResourceDefinition<unknown, ResourceParams>,
      "key" | "mode" | "routes" | "reach" | "dependsOn"
    >,
    membershipField: "membership" | "scopedMembership" | null,
    externalSource: boolean,
  ): RoutingRecord | undefined {
    const { key } = def;
    const field = def.routes ? "routes" : def.reach ? "reach" : null;
    if (field === null) return undefined;
    if (def.routes && def.reach) {
      throw new Error(
        `defineResource: "routes" and "reach" are exclusive for key "${key}" — "routes" is the keyed membership arm, "reach" the non-keyed one`,
      );
    }
    if (externalSource) {
      throw new Error(
        `defineExternalResource: "${field}" on key "${key}" — an external resource's truth lives outside Postgres, so no table change may route into it`,
      );
    }
    // A routed entry takes no cascade: it is reached only through the tables
    // its routes name. An upstream's cascade would serve it a second time, on a
    // path the router cannot see — a FULL cascade overriding a scoped routed
    // refill of the same tuple. Route the upstream's tables instead.
    if (def.dependsOn?.length) {
      throw new Error(
        `defineResource: "${field}" and "dependsOn" are exclusive for key "${key}" — a routed entry takes no cascade; route the tables "${def.dependsOn.map((d) => d.resource.key).join('", "')}" read instead`,
      );
    }
    const plan = (def.routes ?? def.reach)!;
    // Compiler-written only (see `mintRoutePlan`): a route's `columns` decide
    // which updates reach the resource, so an unminted plan — a literal an `as`
    // cast let past the type — is refused.
    if (!isMintedPlan(plan)) {
      throw new Error(
        `defineResource: the "${field}" plan of key "${key}" was not minted — a route plan is written by a query compiler through mintRoutePlan / mintReachPlan, never by hand`,
      );
    }
    if (field === "routes" && !membershipField) {
      throw new Error(
        `defineResource: "routes" requires a membership (membership / scopedMembership) for key "${key}" — a scoped refill never deletes, so only a membership drain can turn a routed change into an exit`,
      );
    }
    if (field === "reach") {
      if (def.mode === "keyed") {
        throw new Error(
          `defineResource: "reach" is the non-keyed arm, but key "${key}" is keyed — a keyed entry routes through "routes" and a membership`,
        );
      }
      const mapped = plan.routes.find((r) => r.map.kind !== "full");
      if (mapped) {
        throw new Error(
          `defineResource: "reach" route "${mapped.id}" on key "${key}" maps "${mapped.map.kind}" — a non-keyed value has no host ids to refill, so every reach route is "full"`,
        );
      }
    }
    const byTable = new Map<string, Route[]>();
    const routeIds = new Set<string>();
    const matchOf = new Map<string, readonly string[]>();
    for (const route of plan.routes) {
      if (routeIds.has(route.id)) {
        throw new Error(
          `defineResource: duplicate route id "${route.id}" for key "${key}"`,
        );
      }
      routeIds.add(route.id);
      matchOf.set(route.id, route.match ?? []);
      const list = byTable.get(route.table);
      if (list) list.push(route);
      else byTable.set(route.table, [route]);
    }
    return {
      plan: plan as RoutePlan<ResourceParams>,
      byTable,
      routeIds,
      matchOf,
      derived: new Set((plan.derivedReads ?? []).map((d) => d.table)),
      drifted: new Set(),
      uses: new Map(),
    };
  }

  // Single internal builder. Produces the full runtime object (with a working
  // `notify` either way) and registers the entry. `defineResource` returns it
  // typed as `Resource` (notify present at runtime but hidden by the type, so a
  // DB-backed resource can't be hand-notified); `defineExternalResource` returns
  // the same object typed as `ExternalResource` and marks the entry external.
  function createResource<T, P extends ResourceParams = ResourceParams>(
    def: ResourceDefinition<T, P>,
    externalSource: boolean,
  ): ExternalResource<T, P> {
    if (registry.has(def.key)) {
      throw new Error(`defineResource: duplicate key "${def.key}"`);
    }
    const { entry, ownDownstreamEdges } = buildEntry(def, externalSource);
    registerEntry(entry, ownDownstreamEdges);
    return handleOf<T, P>(entry);
  }

  /** Index a built entry: the registry, its route tables, and its upstreams' downstream edges. */
  function registerEntry(
    entry: RegistryEntry,
    ownDownstreamEdges: Array<{ upstreamKey: string; edge: DownstreamEdge }>,
  ): void {
    registry.set(entry.key, entry);
    indexRouting(entry);
    // Wire this entry as a downstream of its upstreams. Upstreams must be
    // defined before their downstreams — otherwise the upstream's registry
    // entry doesn't exist yet. Warned lazily during DAG rebuild.
    for (const { upstreamKey, edge } of ownDownstreamEdges) {
      const upstream = registry.get(upstreamKey);
      if (upstream) upstream.downstream.push(edge);
    }
    dagDirty = true;
  }

  /** Put a routed entry on the index `routeTableChange` reads, once per table it routes. */
  function indexRouting(entry: RegistryEntry): void {
    if (!entry.routing) return;
    for (const table of entry.routing.byTable.keys()) {
      const list = routedByTable.get(table);
      if (list) list.push(entry);
      else routedByTable.set(table, [entry]);
    }
  }

  /** The handle `defineResource` / `defineExternalResource` return for an entry. */
  function handleOf<T, P extends ResourceParams>(
    entry: RegistryEntry,
  ): ExternalResource<T, P> {
    return {
      key: entry.key,
      mode: entry.mode,
      schema: entry.schema as ZodParser<T>,
      preload: entry.preload,
      async load(params: P): Promise<T> {
        // Parse here too: this handle method is the one load path that bypasses
        // `timedLoad`, so it must validate to keep the guarantee total — and
        // canonicalize, as every entry point does. The entry's loader, read at
        // call time: a deferred entry gets its loader at bind.
        return (entry.schema as ZodParser<T>).parse(
          await entry.loader(canonicalTuple(entry, params)),
        );
      },
      notify(params?: P): void {
        scheduleNotify(entry, (params ?? {}) as ResourceParams, null);
      },
    };
  }

  /** D32's refusal: `downstream` cascades from `upstream`, a membership entry. */
  function membershipUpstreamMessage(
    downstream: string,
    upstream: string,
  ): string {
    return `defineResource: "${downstream}" cascades from the keyed window "${upstream}" — a membership drain cascades nothing (D32), so the edge would never fire; follow what "${upstream}" follows instead`;
  }

  /** T15's refusal: `downstream` cascades from `upstream`, which is DB-backed. */
  function dbBackedUpstreamMessage(
    downstream: string,
    upstream: string,
  ): string {
    return `defineResource: "${downstream}" dependsOn "${upstream}", which is DB-backed — its writes reach "${downstream}" through the change feed already (its read-set), so a cascade would serve it twice; only an external upstream (truth outside Postgres) cascades`;
  }

  /**
   * Validate a definition and build its registry entry — every check and
   * normalization `createResource` applies, without registering anything, so a
   * deferred entry binds through exactly the same path. `placeholder` marks a
   * deferred entry before its bind: the contract's identity only, so a keyed
   * one has no membership yet (its bind supplies it, and is checked then).
   */
  function buildEntry<T, P extends ResourceParams>(
    def: ResourceDefinition<T, P>,
    externalSource: boolean,
    placeholder = false,
  ): {
    entry: RegistryEntry;
    ownDownstreamEdges: Array<{ upstreamKey: string; edge: DownstreamEdge }>;
  } {
    // `mode` is required on every form (the typed overloads say so); an untyped
    // caller that omits it fails here instead of registering a guessed delivery.
    const mode = def.mode;
    if (mode !== "push" && mode !== "invalidate" && mode !== "keyed") {
      throw new Error(
        `defineResource: mode "push" | "invalidate" | "keyed" is required for key "${def.key}", got ${String(mode)}`,
      );
    }
    if (!def.schema) {
      throw new Error(
        `defineResource: a schema is required for key "${def.key}"`,
      );
    }
    if (mode === "keyed" && !def.keyOf) {
      throw new Error(
        `defineResource: mode "keyed" requires a keyOf for key "${def.key}"`,
      );
    }
    // A bytes value never rides a frame, so its only delivery is `invalidate`
    // (a push would serialize an ArrayBuffer as `{}`). A deferred placeholder
    // is checked at its bind instead (its stand-in mode is `push`).
    if (def.bytes === true && mode !== "invalidate" && !placeholder) {
      throw new Error(
        `defineResource: a bytes resource is mode "invalidate" — "${def.key}" was declared ${mode}`,
      );
    }
    // D37: a legacy scope key a cast smuggled through would do nothing at all.
    refuseLegacyScopeKeys(
      externalSource ? "defineExternalResource" : "defineResource",
      def.key,
      def,
    );
    // Membership (bounded `membership` or the M5 `scopedMembership` alias) is
    // only sound on a keyed OWN-IDENTITY resource — the membership diff
    // reconciles the loader's own row ids against the per-pk snapshot — and,
    // DB-backed, only a routed one: `routes` is what scopes a change to its
    // rows. An external one is never routed (D31): it is a bounded window
    // whose change is its own `notify` (`ExternalWindowPolicy`). Fail loudly
    // at registration.
    if (def.scopedMembership && def.membership) {
      throw new Error(
        `defineResource: "scopedMembership" and "membership" are mutually exclusive for key "${def.key}" — scopedMembership IS the unbounded-window membership alias`,
      );
    }
    const membershipField = def.membership
      ? "membership"
      : def.scopedMembership
        ? "scopedMembership"
        : null;
    if (membershipField) {
      if (mode !== "keyed") {
        throw new Error(
          `defineResource: ${membershipField} requires mode "keyed" for key "${def.key}"`,
        );
      }
      if (!externalSource && !def.routes) {
        throw new Error(
          `defineResource: ${membershipField} requires routes (a compiler-minted route plan) for key "${def.key}"`,
        );
      }
    }

    const routing = routingRecordFor(
      def as ResourceDefinition<unknown, ResourceParams>,
      membershipField,
      externalSource,
    );
    // The external window (`ExternalWindowPolicy`) — never routed: its routes
    // were refused above. The types allow only this arm; this holds the line
    // for a cast.
    if (
      externalSource &&
      membershipField !== null &&
      (def.membership?.kind !== "window" ||
        (def.membership as { windowIdsOf?: unknown }).windowIdsOf !==
          undefined ||
        def.membership.orderSignatureOf !== undefined)
    ) {
      throw new Error(
        `defineExternalResource: key "${def.key}" — an external keyed entry is a bounded window ({ kind: "window", limitOf, familyOf? }): no point set or alias, and no windowIdsOf / orderSignatureOf (its ids are its own read's, and every change re-reads the tuple whole)`,
      );
    }
    // Keyed ⇒ membership: the keyed drain is the membership drain; a keyed
    // entry without one would have no path that reconciles its rows (the
    // types allow no such declaration — this holds the line for an untyped
    // caller or a cast). DB-backed, it is routed too (above); external, never
    // (D31 — `routingRecordFor` refuses its routes).
    if (mode === "keyed" && !membershipField && !placeholder) {
      throw new Error(
        `defineResource: a keyed entry is a membership entry — key "${def.key}" declares no membership (membership / scopedMembership)${externalSource ? "" : " and routes"}`,
      );
    }
    // The routed alias's ORDER BY is the compiler's, so it always states the
    // signature of it (type: required on the routed `ScopePolicy` arm); an
    // untyped caller without one would leave an in-place reorder stale.
    if (
      def.routes &&
      def.scopedMembership &&
      def.scopedMembership.orderSignatureOf === undefined
    ) {
      throw new Error(
        `defineResource: a routed scopedMembership requires orderSignatureOf for key "${def.key}" — without it an UPDATE moving an ORDER BY column never reorders the alias`,
      );
    }
    // A bounded window's size decides whether an exit re-derives (a window
    // holding fewer rows than it holds its whole range); the types require
    // it, this holds the line for an untyped caller or a cast.
    if (
      def.membership?.kind === "window" &&
      typeof def.membership.limitOf !== "function"
    ) {
      throw new Error(
        `defineResource: a window membership requires limitOf for key "${def.key}" — without it the runtime cannot tell a full window (an exit may pull a hidden row in) from one holding its whole range`,
      );
    }
    // Normalize both public forms into the one internal record every consumer
    // branches on. The alias is the ONLY unbounded window (`bounded: false`) —
    // it keeps L2 persistence and the retain snapshot encoder; a declared
    // `membership` is bounded by contract (excluded from persistence, hashed).
    const membership: MembershipRecord | undefined = def.membership
      ? def.membership.kind === "window"
        ? {
            kind: "window",
            // An external window's ids are its own read's: the loader at the
            // tuple, its rows mapped to their ids. Every change of it is a
            // FULL re-read (its `notify`), so no path calls this today; it is
            // what the window's ids MEAN, never a second source of them.
            windowIdsOf: externalSource
              ? async (params: ResourceParams): Promise<string[]> =>
                  ((await timedLoad(entry, params)) as readonly unknown[]).map(
                    (row) => entry.keyOf!(row),
                  )
              : (def.membership.windowIdsOf as (
                  params: ResourceParams,
                ) => Promise<string[]>),
            bounded: true,
            orderSignatureOf: def.membership.orderSignatureOf as
              ((row: unknown, params: ResourceParams) => string) | undefined,
            limitOf: def.membership.limitOf as (
              params: ResourceParams,
            ) => number,
            ...(def.membership.familyOf !== undefined
              ? {
                  familyOf: def.membership.familyOf as (
                    params: ResourceParams,
                  ) => string,
                }
              : {}),
          }
        : {
            kind: "point",
            idsOf: def.membership.idsOf as (
              params: ResourceParams,
            ) => readonly string[],
          }
      : def.scopedMembership
        ? {
            kind: "window",
            windowIdsOf: def.scopedMembership.orderOf as (
              params: ResourceParams,
            ) => Promise<string[]>,
            bounded: false,
            orderSignatureOf: def.scopedMembership.orderSignatureOf as
              ((row: unknown, params: ResourceParams) => string) | undefined,
          }
        : undefined;
    // The `authorize` seam is enforced on the WS subscribe path ONLY —
    // `handleResourceHttp` (and the client's sub-error → HTTP-refetch heal)
    // would serve the value without ever consulting it, a silent authorization
    // bypass. Refuse the declaration until HTTP parity exists, so the first
    // real consumer hits this wall instead of shipping the hole. Build parity
    // (one shared admission check across handleSub/handleSubBatch/
    // handleResourceHttp) before deleting this guard.
    if (def.authorize) {
      throw new Error(
        `defineResource: "authorize" is not enforced on the HTTP read path yet for key "${def.key}" — build handleResourceHttp parity before using this seam`,
      );
    }
    const upstreamKeys: string[] = [];
    const ownDownstreamEdges: Array<{
      upstreamKey: string;
      edge: DownstreamEdge;
    }> = [];
    for (const dep of def.dependsOn ?? []) {
      if (dep.toSubscribed && dep.map) {
        throw new Error(
          `defineResource: dependsOn "${dep.resource.key}" sets both "map" and "toSubscribed" for key "${def.key}" — toSubscribed IS the downstream tuple set`,
        );
      }
      // A5 — route the table, not the resource. A cascade out of a routed entry
      // cannot be served: the legacy router drops the downstream's own delivery
      // of an edge-covered origin (expecting the upstream's cascade), while a
      // routed upstream only drains the tuples a change reaches — so a
      // subscriber-less upstream tuple would lose the update for good. The
      // downstream routes the upstream's tables itself instead.
      const upstream = registry.get(dep.resource.key);
      if (upstream?.routing) {
        throw new Error(
          `defineResource: "${def.key}" dependsOn the routed resource "${dep.resource.key}" — route the table, not the resource: a routed entry is never a cascade upstream`,
        );
      }
      // D32, the external window: a membership drain cascades nothing, so a
      // cascade out of one would never fire.
      if (upstream?.membership) {
        throw new Error(membershipUpstreamMessage(def.key, upstream.key));
      }
      // T15 — only an external upstream cascades (see `DependsOnEntry`). The
      // type refuses a DB-backed handle; this holds the line for a cast. An
      // upstream not registered yet is checked when it registers (below, the
      // other order) and again at the DAG rebuild; a deferred placeholder
      // reports `externalSource: false` before its bind, so it is left to A5 /
      // the bind.
      if (upstream && !upstream.externalSource && !deferred.has(upstream.key)) {
        throw new Error(dbBackedUpstreamMessage(def.key, upstream.key));
      }
      upstreamKeys.push(dep.resource.key);
      ownDownstreamEdges.push({
        upstreamKey: dep.resource.key,
        edge: {
          downstreamKey: def.key,
          ...(dep.toSubscribed ? { toSubscribed: true as const } : {}),
          map: dep.map as
            | ((
                upstreamParams: ResourceParams,
                upstreamValue: unknown,
              ) => ResourceParams[])
            | undefined,
        },
      });
    }
    // A routed entry's `recomputeOn`: one edge per external upstream tuple.
    // The upstream must already be registered (a routed entry binds late —
    // deferred — or registers after the plugin whose value it reads), so its
    // externality can be checked here rather than guessed.
    for (const r of def.recomputeOn ?? []) {
      if (!routing || !def.routes) {
        throw new Error(
          `defineResource: "recomputeOn" is for a routed entry (routes) — key "${def.key}" is not one; an unrouted entry takes \`dependsOn\``,
        );
      }
      const upstream = registry.get(r.resource.key);
      if (!upstream) {
        throw new Error(
          `defineResource: "${def.key}" recomputes on "${r.resource.key}", which is not registered — register the upstream first`,
        );
      }
      if (!upstream.externalSource) {
        throw new Error(
          `defineResource: "${def.key}" recomputes on "${r.resource.key}", which is DB-backed — a routed entry routes the tables it reads itself; only an external upstream (truth outside Postgres) may recompute it`,
        );
      }
      if (upstream.membership) {
        throw new Error(membershipUpstreamMessage(def.key, upstream.key));
      }
      upstreamKeys.push(upstream.key);
      ownDownstreamEdges.push({
        upstreamKey: upstream.key,
        edge: {
          downstreamKey: def.key,
          routedRecompute: {
            upstreamPk: paramsKey(canonicalTuple(upstream, r.params)),
          },
        },
      });
    }
    // A5, D32 and T15, the other registration order: a downstream registered
    // first already names this entry as its upstream — refused when this
    // entry is routed, a membership entry (an external window), or DB-backed
    // (a deferred placeholder is checked at its bind).
    if (routing || membership || (!externalSource && !placeholder)) {
      for (const other of registry.values()) {
        if (!other.upstreamKeys.includes(def.key)) continue;
        throw new Error(
          routing
            ? `defineResource: "${other.key}" dependsOn the routed resource "${def.key}" — route the table, not the resource: a routed entry is never a cascade upstream`
            : membership
              ? membershipUpstreamMessage(other.key, def.key)
              : dbBackedUpstreamMessage(other.key, def.key),
        );
      }
    }
    const entry: RegistryEntry = {
      key: def.key,
      mode,
      ...(def.optionalParams !== undefined
        ? { optionalParams: def.optionalParams }
        : {}),
      ...(def.refusals !== undefined ? { refusals: def.refusals } : {}),
      ...(def.bytes === true ? { bytes: true as const } : {}),
      externalSource,
      ...(def.freshness !== undefined ? { freshness: def.freshness } : {}),
      schema: def.schema as ZodParser<unknown>,
      loader: def.loader as (
        params: ResourceParams,
        ctx?: { affectedIds: readonly string[] },
      ) => Promise<unknown> | unknown,
      keyOf: def.keyOf as ((row: unknown) => string) | undefined,
      membership,
      preload: def.preload,
      snapshots: mode === "keyed" ? new Map() : undefined,
      versions: new Map(),
      pendingNotifies: new Map(),
      debounceMs: def.debounceMs,
      subCounts: new Map(),
      tracked: new Map(),
      spans: new Map(),
      pendingAcks: new Map(),
      draining: new Set(),
      ...(routing ? { routing } : {}),
      upstreamKeys,
      downstream: [],
      onFirstSubscribe: def.onFirstSubscribe as
        ((params: ResourceParams) => void | Promise<void>) | undefined,
      onLastUnsubscribe: def.onLastUnsubscribe as
        ((params: ResourceParams) => void) | undefined,
      revalidate: def.revalidate as
        ((params: ResourceParams) => Promise<string>) | undefined,
      authorize: def.authorize as
        ((params: ResourceParams) => boolean | Promise<boolean>) | undefined,
      validateParams: def.validateParams ?? acceptAnyParams,
    };
    return { entry, ownDownstreamEdges };
  }

  // ── Deferred resources ──────────────────────────────────────────────
  // A resource whose server half can only be compiled once the plugin graph's
  // contributions are known (a `network/live` collection whose columns other
  // plugins contribute). Its identity — key, mode, schema, keyed-ness, preload —
  // exists at module eval (so `Resource.Declare` and the boot snapshot's key set
  // see it), and its loader, scope policy and routes arrive at
  // `bindDeferredResources()`, which the boot sequence runs right after
  // collecting contributions, before anything is served or any trigger is
  // rebuilt from the route layout. Serving one before it is bound throws.
  const deferred = new Map<
    string,
    {
      entry: RegistryEntry;
      bind: () => ResourceDefinition<unknown, ResourceParams>;
    }
  >();

  function defineDeferredResource<T, P extends ResourceParams = ResourceParams>(
    contract: KeyedResourceContract<T, P>,
    bind: () => KeyedServerResourceOptions<T, P> & ScopePolicy<P>,
  ): Resource<T, P>;
  function defineDeferredResource<T, P extends ResourceParams = ResourceParams>(
    contract: ResourceContract<T, P> & { keyed?: never },
    bind: () => ServerResourceOptions<T, P>,
  ): Resource<T, P>;
  function defineDeferredResource<T, P extends ResourceParams = ResourceParams>(
    contract: ResourceContract<T, P>,
    bind: () =>
      | ServerResourceOptions<T, P>
      | (KeyedServerResourceOptions<T, P> & ScopePolicy<P>),
  ): Resource<T, P> {
    const key = contract.key;
    if (registry.has(key)) {
      throw new Error(`defineResource: duplicate key "${key}"`);
    }
    const unbound = (): never => {
      throw new Error(
        `resource "${key}" is deferred and not bound yet — its server half compiles at bindDeferredResources(), after contributions are collected`,
      );
    };
    // The placeholder: the contract's own identity, and a loader that refuses.
    // A non-keyed deferred resource is a push value (its bound options must
    // say so — checked at bind).
    const { entry } = buildEntry(
      {
        key,
        schema: contract.schema,
        mode: contract.keyed ? "keyed" : "push",
        keyOf: contract.keyed?.keyOf,
        preload: contract.preload,
        ...(contract.optionalParams !== undefined
          ? { optionalParams: contract.optionalParams }
          : {}),
        ...(contract.refusals !== undefined
          ? { refusals: contract.refusals }
          : {}),
        ...(contract.bytes === true ? { bytes: true as const } : {}),
        // The contract's gate until the bind hands the server's own.
        validateParams: contract.validateParams,
        loader: unbound,
      } as ResourceDefinition<unknown, ResourceParams>,
      false,
      true,
    );
    registerEntry(entry, []);
    deferred.set(key, {
      entry,
      bind: () =>
        contractToDefinition(
          "defineResource",
          contract,
          bind() as ServerResourceOptions<T, P>,
        ) as unknown as ResourceDefinition<unknown, ResourceParams>,
    });
    return handleOf<T, P>(entry);
  }

  /**
   * Bind every deferred resource defined so far: compile its server half (its
   * `bind`), run it through the same checks every resource gets, and give the
   * registered entry its loader, scope policy and routes. A bind that throws
   * fails the call — the boot sequence runs it, so a graph with an unbindable
   * resource never serves. One defined later stays unbound (serving it throws)
   * until the next call.
   */
  function bindDeferredResources(): void {
    for (const [key, { entry, bind }] of deferred) {
      deferred.delete(key);
      const def = bind();
      if (def.mode !== entry.mode) {
        throw new Error(
          `bindDeferredResources: "${key}" was declared ${entry.mode} and bound ${def.mode}`,
        );
      }
      const built = buildEntry(def, false);
      Object.assign(entry, {
        loader: built.entry.loader,
        membership: built.entry.membership,
        debounceMs: built.entry.debounceMs,
        routing: built.entry.routing,
        upstreamKeys: built.entry.upstreamKeys,
        onFirstSubscribe: built.entry.onFirstSubscribe,
        onLastUnsubscribe: built.entry.onLastUnsubscribe,
        revalidate: built.entry.revalidate,
        authorize: built.entry.authorize,
        validateParams: built.entry.validateParams,
      } satisfies Partial<RegistryEntry>);
      indexRouting(entry);
      for (const { upstreamKey, edge } of built.ownDownstreamEdges) {
        const upstream = registry.get(upstreamKey);
        if (upstream) upstream.downstream.push(edge);
      }
      dagDirty = true;
    }
  }

  // DB-backed resource: the runtime object carries a `notify` method, but the
  // returned type hides it (`Resource` has no `notify`), so hand-notifying a
  // DB-backed resource is a compile error — the change-feed drives it instead.
  //
  // Two call shapes (see the `ResourceRuntime` interface): the flat strict
  // `DefineResourceInput` (keyed ⇒ scope policy mandatory) and the
  // `(contract, serverOpts)` form that reads key/schema/keyed-ness off a shared
  // client descriptor so server and client can't disagree about them. Both widen
  // back to the loose `ResourceDefinition` that `createResource` registers.
  function defineResource<T, P extends ResourceParams = ResourceParams>(
    def: DefineResourceInput<T, P>,
  ): Resource<T, P>;
  function defineResource<T, P extends ResourceParams = ResourceParams>(
    contract: KeyedResourceContract<T, P>,
    opts: KeyedServerResourceOptions<T, P> & ScopePolicy<P>,
  ): Resource<T, P>;
  function defineResource<T, P extends ResourceParams = ResourceParams>(
    contract: ResourceContract<T, P> & { keyed?: never },
    opts: ServerResourceOptions<T, P>,
  ): Resource<T, P>;
  function defineResource<T, P extends ResourceParams = ResourceParams>(
    a: DefineResourceInput<T, P> | ResourceContract<T, P>,
    opts?:
      | ServerResourceOptions<T, P>
      | (KeyedServerResourceOptions<T, P> & ScopePolicy<P>),
  ): Resource<T, P> {
    const def = opts
      ? contractToDefinition(
          "defineResource",
          a as ResourceContract<T, P>,
          opts,
        )
      : (a as ResourceDefinition<T, P>);
    return createResource(def, false);
  }

  // Escape-hatch resource (truth outside Postgres): exposes a callable `notify`.
  // Two shapes mirroring `defineResource`'s non-keyed ones: the flat loose
  // `ResourceDefinition` (push / invalidate), and the `(contract, serverOpts)`
  // form that reads key/schema AND `preload` off a shared client descriptor.
  // Never ROUTED (D31): its truth is outside Postgres, so nothing routes into
  // it — `buildEntry` refuses routes a cast let through. Keyed only as a
  // bounded window from a shared keyed contract (`ExternalWindowPolicy`).
  function defineExternalResource<T, P extends ResourceParams = ResourceParams>(
    def: ExternalDefinition<T, P>,
  ): ExternalResource<T, P>;
  function defineExternalResource<T, P extends ResourceParams = ResourceParams>(
    contract: KeyedResourceContract<T, P>,
    opts: KeyedServerResourceOptions<T, P> & ExternalWindowPolicy<P>,
  ): ExternalResource<T, P>;
  function defineExternalResource<T, P extends ResourceParams = ResourceParams>(
    contract: ResourceContract<T, P> & { keyed?: never },
    opts: ServerResourceOptions<T, P> & { reach?: never },
  ): ExternalResource<T, P>;
  function defineExternalResource<T, P extends ResourceParams = ResourceParams>(
    a: ResourceDefinition<T, P> | ResourceContract<T, P>,
    opts?:
      | ServerResourceOptions<T, P>
      | (KeyedServerResourceOptions<T, P> & ExternalWindowPolicy<P>),
  ): ExternalResource<T, P> {
    const def = opts
      ? contractToDefinition(
          "defineExternalResource",
          a as ResourceContract<T, P>,
          // The external window's membership has no `windowIdsOf` (the
          // runtime derives it — `buildEntry`); every other field is the
          // two-arg form's.
          opts as ServerResourceOptions<T, P>,
        )
      : (a as ResourceDefinition<T, P>);
    return createResource(def, true);
  }

  // Rebuild the topological order and warn on cycles or dangling upstream refs.
  // Called lazily — amortised to flushNotifies and the debug endpoint. Two
  // invariants registration already holds are asserted here too, over the
  // whole graph, so a regression of either check is loud (rung 4):
  //  - D32: a membership entry has no downstream. A5 refuses a cascade out of
  //    a routed entry and D32 one out of an external window, in both
  //    registration orders, so the membership drains cascade nothing.
  //  - T15: every upstream is external — a deferred placeholder excepted, which
  //    reports `externalSource: false` until its bind (checked then).
  function rebuildDag(): void {
    if (!dagDirty) return;

    // Asserted before the DAG counts as rebuilt, so a violation stays loud on
    // every flush rather than once.
    for (const entry of registry.values()) {
      if (entry.membership && entry.downstream.length > 0) {
        throw new Error(
          `[resources] membership entry "${entry.key}" has downstream edges (${entry.downstream.map((d) => d.downstreamKey).join(", ")}) — A5 / D32 must refuse a cascade out of a membership entry`,
        );
      }
      for (const upKey of entry.upstreamKeys) {
        const up = registry.get(upKey);
        if (up && !up.externalSource && !deferred.has(upKey)) {
          throw new Error(dbBackedUpstreamMessage(entry.key, upKey));
        }
      }
    }
    dagDirty = false;

    const order: RegistryEntry[] = [];
    const state = new Map<string, "visiting" | "done">();
    const cycles: string[][] = [];

    const visit = (entry: RegistryEntry, stack: string[]): void => {
      const s = state.get(entry.key);
      if (s === "done") return;
      if (s === "visiting") {
        const i = stack.indexOf(entry.key);
        cycles.push(stack.slice(i >= 0 ? i : 0).concat(entry.key));
        return;
      }
      state.set(entry.key, "visiting");
      stack.push(entry.key);
      // Post-order: every upstream's depth is finalized before we read it here.
      // Longest-path depth = 1 + max upstream depth (0 for a root). `?? 0` keeps
      // dangling-upstream (skipped) and cycle (back-edge, depth not yet set)
      // cases finite and crash-free — matching the warn-only phase-1 semantics.
      let depth = 0;
      for (const upKey of entry.upstreamKeys) {
        const up = registry.get(upKey);
        if (!up) {
          console.warn(
            `[resources] "${entry.key}" depends on unknown resource "${upKey}" (upstream not yet defined at ${entry.key}'s registration time?)`,
          );
          continue;
        }
        visit(up, stack);
        depth = Math.max(depth, (up.depth ?? 0) + 1);
      }
      stack.pop();
      entry.depth = depth;
      state.set(entry.key, "done");
      order.push(entry);
    };

    for (const entry of registry.values()) visit(entry, []);

    if (cycles.length > 0) {
      for (const cycle of cycles) {
        // Phase 1: warn only. Phase 3 promotes this to a hard failure.
        console.warn(
          `[resources] dependsOn cycle detected: ${cycle.join(" -> ")}`,
        );
      }
    }

    topoOrder = order;
    // Group by depth. Post-order is not depth-sorted across independent subtrees,
    // so build the levels explicitly rather than slicing `order`.
    const maxDepth = order.reduce((m, e) => Math.max(m, e.depth ?? 0), 0);
    const levels: RegistryEntry[][] = Array.from(
      { length: maxDepth + 1 },
      () => [],
    );
    for (const e of order) levels[e.depth ?? 0]!.push(e);
    topoLevels = levels;
  }

  // --- Broadcast machinery ---

  function subscribersFor(key: string, pk: string): SocketState[] {
    const out: SocketState[] = [];
    for (const st of sockets.values()) {
      const inner = st.subs.get(key);
      if (inner?.has(pk)) out.push(st);
    }
    return out;
  }

  // The sockets holding (key, pk) on behalf of at least one tab that asked for
  // standalone ack frames — the only recipients of `{ kind: "ack" }`.
  function ackSubscribersFor(key: string, pk: string): SocketState[] {
    const out: SocketState[] = [];
    for (const st of sockets.values()) {
      const rec = st.subs.get(key)?.get(pk);
      if (rec !== undefined && rec.ackTabs.size > 0) out.push(st);
    }
    return out;
  }

  // Does any socket hold this tuple for a tab that asked for acks? The feed
  // router's gate for scheduling an ACK-ONLY pending on a tuple the change
  // missed — without an asker there is nobody to deliver it to.
  function tupleWantsAcks(key: string, params: ResourceParams): boolean {
    return ackSubscribersFor(key, paramsKey(params)).length > 0;
  }

  // Every frame the runtime sends is one of the protocol's, carrying only the
  // fields its kind declares (`ExactServerFrame`, `packages/resource-protocol`
  // — checked however the frame was built, a variable or a spread included): a
  // new field or kind is an edit there, which moves `PROTOCOL` — so tabs
  // reading the old vocabulary never share a socket with tabs reading the new
  // one.
  function sendJson<F extends ServerFrame>(
    ws: ServerWebSocket<WsData>,
    obj: ExactServerFrame<F>,
  ): void {
    try {
      ws.send(JSON.stringify(obj));
      // eslint-disable-next-line promise-safety/no-bare-catch
    } catch {
      // close handler will clean up
    }
  }

  // Broadcast one frame to N subscribers: serialize ONCE, send the string to
  // each socket. The per-subscriber `sendJson` loop this replaces stringified
  // the identical frame N times — for a large value that multiplied the
  // delivery path's allocation churn by subscriber count (the ±60–70 MB/10 s
  // GC sawtooth; research/perfs/2026-07-16-main-paging-victim-investigation-PLAN.md
  // §B2). Synchronous end-to-end so the no-await-before-send property of the
  // push path (H5a) is untouched. Per-socket try/catch mirrors sendJson: a
  // dead socket's close handler cleans up, the rest still receive.
  // Returns the serialized frame's length in UTF-16 chars (0 when nothing was
  // sent) — the delivery's `frameChars` measure, read off the one string that
  // was already built, so measuring costs nothing extra.
  function broadcastJson<F extends ServerFrame>(
    subs: readonly SocketState[],
    obj: ExactServerFrame<F>,
  ): number {
    if (subs.length === 0) return 0;
    const str = JSON.stringify(obj);
    for (const s of subs) {
      try {
        s.ws.send(str);
        // eslint-disable-next-line promise-safety/no-bare-catch
      } catch {
        // close handler will clean up
      }
    }
    return str.length;
  }

  // A declared refusal is an ANSWER, not a failure: the value moved into a
  // state the reader must see (the file it reads was deleted → `missing`, the
  // query became invalid → `invalid-query`). Tell every holder, as the sub-ack
  // read does; the client's sub-error handler then reads over HTTP and
  // surfaces the typed refusal (422) with the last value as `stale`.
  // `declaredLoad` already turned an undeclared code into a plain Error, so
  // only a declared one arrives as a ResourceRefusal. Every push-path loader
  // failure that ends a drain calls this — the plain-value drain and the
  // keyed-window FULL (`drainMembershipFull`, where a keyed refill's failure
  // also lands) alike — so a paged value's refusal reaches its pages.
  function broadcastRefusal(
    subs: readonly SocketState[],
    entry: RegistryEntry,
    params: ResourceParams,
    err: unknown,
  ): void {
    if (!(err instanceof ResourceRefusal)) return;
    broadcastJson(subs, {
      kind: "sub-error",
      key: entry.key,
      params,
      reason: "refused",
      code: err.code,
      message: err.message,
    });
  }

  // Schedule a single global microtask flush, guarded so concurrent callers
  // coalesce onto one flush. The immediate (non-debounced) path.
  function scheduleFlush(): void {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      void flushNotifies();
    });
  }

  async function withNotifyBatch<T>(fn: () => Promise<T>): Promise<T> {
    batchDepth++;
    try {
      return await fn();
    } finally {
      batchDepth--;
      if (batchDepth === 0 && !flushScheduled) {
        for (const entry of registry.values()) {
          if (entry.pendingNotifies.size > 0 || entry.pendingAcks.size > 0) {
            scheduleFlush();
            break;
          }
        }
      }
    }
  }

  function scheduleNotify(
    entry: RegistryEntry,
    rawParams: ResourceParams,
    affected: Set<string> | null,
    opts?: {
      source?: "hand" | ChangeSource | "synthetic";
      deleted?: Set<string>;
      /** Source txid (feed only) — mutation-ack attribution. Hand/synthetic
       *  notifies never carry one, so their frames are structurally ack-less. */
      sourceTx?: string;
      /** Wall-clock epoch ms of the change (feed). A hand `notify()` defaults to
       *  now — the call IS the change for an external resource. */
      changedAt?: number;
      /** Reverse routes the drain must resolve (routed entries only). */
      unresolved?: readonly UnresolvedReverse[];
    },
  ): void {
    // A25: a scoped recompute (row ids) exists only for a membership entry —
    // the only drain that refills rows. Every other entry recomputes FULL; a
    // non-null set reaching one would be a router bug, not a narrower load.
    if (affected !== null && !entry.membership) {
      throw new Error(
        `[resources] scoped notify (${affected.size} id(s)) for "${entry.key}", which has no membership — only a routed membership entry recomputes by row id`,
      );
    }
    // The funnel for `notify`, the change feed, `triggerResourcePush` and the
    // L2 recompute: one canonical tuple, however the caller spelled it.
    const params = canonicalTuple(entry, rawParams);
    const pk = paramsKey(params);
    // Self-verification recorder (cascade is byte-identical regardless of source).
    const source = opts?.source ?? "hand";
    // A synthetic push (the debug churn emitter) drives the identical cascade but
    // is NOT a real change, so it must not touch the hand-vs-feed self-verification
    // counters or spam the read-set-gap warning at N/sec — it skips both branches
    // and falls straight through to the shared merge + flush-scheduling tail.
    if (source === "feed") {
      countFeed(entry.key, pk);
    } else if (source === "producer") {
      // A producer change is no feed intent (it never matches a hand-notify)
      // and no hand-notify (it is the table's declared change source, so a
      // read-set-gap warning would be false): counted, nothing more.
      statsFor(entry.key).producer++;
    } else if (source === "hand") {
      const now = performance.now();
      const stats = statsFor(entry.key);
      stats.hand++;
      stats.lastHandAt = now;
      // A hand-notify with no recent feed intent for the same (resource, pk)
      // means the change-feed did NOT cover this change — i.e. the L3 read-set
      // capture is missing a table this resource reads. That is exactly the bug
      // class L4 eliminates, so surface it (loud, but not an error — the parallel
      // run is expected to find these during the migration).
      //
      // Never for an external-source entry (`defineExternalResource`): its truth
      // lives outside Postgres, so a hand-notify is by design its ONLY source and
      // the feed never has anything to match. The warning was always false for
      // them — and, for a resource notified on every change, it was most of the
      // log (main held ~269k lines for `config-v2.values` alone).
      if (!entry.externalSource && !hasRecentFeedIntent(entry.key, pk, now)) {
        console.warn(
          `[live-state] read-set-gap candidate: hand-notify for "${entry.key}" pk=${pk} had no matching change-feed intent within ${FEED_MATCH_WINDOW_MS}ms (a table this resource reads may be missing from the L3 read-set)`,
        );
      }
    }
    mergePending(
      entry.pendingNotifies,
      pk,
      params,
      affected,
      opts?.deleted,
      opts?.sourceTx !== undefined ? new Set([opts.sourceTx]) : undefined,
      opts?.changedAt ?? (source === "hand" ? Date.now() : undefined),
      opts?.unresolved,
    );
    armFlush(entry);
  }

  // Owe the writer of `xid` an ack on a tuple its change SKIPPED (see
  // `PendingAck`): never a pending, so the skip can never reload the tuple — not
  // even a persisted one, whose pendings always recompute FULL. The caller has
  // already checked that someone asked for acks on the tuple (`tupleWantsAcks`).
  // It is still a feed delivery to this tuple, counted as one (`countFeed`), so
  // the hand-vs-feed counters and the read-set-gap match see it.
  function scheduleAck(
    entry: RegistryEntry,
    pk: string,
    params: ResourceParams,
    xid: string,
  ): void {
    countFeed(entry.key, pk);
    let owed = entry.pendingAcks.get(pk);
    if (!owed) {
      owed = { params, xids: new Set(), overflow: false };
      entry.pendingAcks.set(pk, owed);
    }
    if (!owed.overflow) {
      owed.xids.add(xid);
      if (owed.xids.size > SOURCE_TX_CAP) {
        owed.overflow = true;
        owed.xids.clear();
      }
    }
    armFlush(entry);
  }

  // Get `entry`'s pending work drained: nothing inside a `withNotifyBatch` (its
  // exit schedules the flush), the entry's debounce window when it declares one,
  // the next microtask flush otherwise.
  function armFlush(entry: RegistryEntry): void {
    if (batchDepth > 0) return;
    // Debounced entries do not ride the immediate flush: arm a per-entry
    // fixed-window timer (only if not already armed — never re-armed within a
    // window, so a continuously-ticking source still flushes every debounceMs).
    if (entry.debounceMs) {
      if (entry.debounceTimer === undefined) {
        entry.debounceTimer = setTimeout(() => {
          entry.debounceTimer = undefined;
          scheduleFlush();
        }, entry.debounceMs);
      }
      return;
    }
    scheduleFlush();
  }

  // A bounded-membership entry: a window with a bound (declared via the public
  // `membership` selector) or a point set. These are NEVER L2-persisted — their
  // value is a per-subscription bounded working set, not a whole-collection
  // materialization; persisting them would reintroduce the FULL-recompute-and-
  // persist-on-every-change churn the bounded contract exists to kill. Read
  // straight off the definition (generic — never by resource name). The legacy
  // `scopedMembership` alias (`bounded: false`) keeps persistence.
  function membershipBounded(entry: RegistryEntry): boolean {
    const m = entry.membership;
    if (!m) return false;
    return m.kind === "point" || m.bounded;
  }

  // The unbounded-window alias (`scopedMembership`) — the ONLY membership shape
  // whose persisted-reconstruction path exists, and therefore the only one that
  // retains snapshot bytes and keeps its snapshot across N→0 (when persisted).
  function isUnboundedWindow(entry: RegistryEntry): boolean {
    return entry.membership?.kind === "window" && !entry.membership.bounded;
  }

  // The M5 exception to "a snapshot lives as long as its tracking span": a
  // PERSISTED unbounded-window alias recomputes on every change whether or not
  // anyone is subscribed, and reconstructs its persisted value FROM the
  // snapshot, so it keeps it across N→0 (see `releaseSubRefcount`).
  // Drop a tuple's keyed diff base; the order signatures and base floor go with
  // it (their lifecycle mirrors the snapshot's).
  function evictSnapshot(entry: RegistryEntry, pk: string): void {
    entry.snapshots?.delete(pk);
    entry.orderSigs?.delete(pk);
    entry.baseFloors?.delete(pk);
  }

  function keepsIdleSnapshot(entry: RegistryEntry): boolean {
    return (
      isUnboundedWindow(entry) &&
      !entry.externalSource &&
      (opts.shouldPersist?.(entry.key) ?? false)
    );
  }

  // Who a drain's snapshot write is for: `"kept"` for a snapshot that outlives
  // its subscribers (`keepsIdleSnapshot`), else the tuple's tracking span, or
  // undefined when the tuple is not tracked. A drain reads it before its first
  // await and writes the snapshot (and its order signatures) — and ships its
  // frames — only while it is unchanged: across an N→0 the snapshot was evicted
  // and nothing routes to the tuple, so a write would resurrect a base that goes
  // stale unseen, and a re-subscribe's routing would read membership off it.
  function snapshotOwner(
    entry: RegistryEntry,
    pk: string,
  ): number | "kept" | undefined {
    return keepsIdleSnapshot(entry) ? "kept" : entry.spans.get(pk);
  }

  // ── L2 persists ─────────────────────────────────────────────────────────
  //
  // Two modes (`PersistMeta`): a FULL recompute REPLACES the row with its value
  // and its flight's watermark; a persisted alias's scoped refills are written
  // as a FLOOR persist — its value reconstructed from the in-memory snapshot,
  // floored by the snapshot's base floor — once per trailing window, so a burst
  // of row changes costs one write. Per (entry, pk) the writes are serialized
  // (`persistChains`), so a floor persist can never land under a replace that
  // was issued before it.

  // The serialized persist chain per (entry key, pk), and the armed trailing
  // floor windows. A chain link never rejects (each run reports its own
  // failure), so the chain survives one.
  const persistChains = new Map<string, Promise<void>>();
  const armedFloors = new Map<string, ReturnType<typeof setTimeout>>();
  const persistWindowMs = opts.persistWindowMs ?? 2000;
  // Per-key L2 bookkeeping for the `_debug` payload: when this process last
  // replaced / floor-wrote the row, and the row's `position_at` as last known
  // (seeded from L2 at boot, moved by every replace).
  const persistStats = new Map<
    string,
    { lastReplaceAt?: number; lastFloorAt?: number; l2PositionAt?: number }
  >();
  const persistSlot = (key: string, pk: string): string => `${key}\u0000${pk}`;
  const statsOf = (key: string) => {
    let st = persistStats.get(key);
    if (!st) {
      st = {};
      persistStats.set(key, st);
    }
    return st;
  };

  function enqueuePersist(
    entry: RegistryEntry,
    pk: string,
    run: () => Promise<void>,
  ): Promise<void> {
    const slot = persistSlot(entry.key, pk);
    const next = (persistChains.get(slot) ?? Promise.resolve())
      .then(run)
      .catch((err: unknown) => {
        reportLoaderError(`snapshot persist failed for ${entry.key}`, err);
      });
    persistChains.set(slot, next);
    void next.then(() => {
      if (persistChains.get(slot) === next) persistChains.delete(slot);
    });
    return next;
  }

  // The L2 definition (A18) of an entry — its routed plan's fingerprint of
  // its compiled SQL (`RoutePlanInput.definition`), read off the plan rather
  // than copied onto the entry, so every path that builds or binds an entry
  // (`createResource`, `bindDeferredResources`) carries it by construction.
  // Every persist writes it and every L2 read requires it
  // (`persistedDefinitions()`), so a row a different definition wrote is never
  // served or seeded. Null ⇒ the row's definition is NULL.
  function definitionOf(entry: RegistryEntry): string | null {
    return entry.routing?.plan.definition ?? null;
  }

  // Record (or forget) the base floor of the snapshot just rebuilt from a FULL
  // read — see `RegistryEntry.baseFloors`. Only a persisted alias floor-persists,
  // so only an unbounded window keeps one. An undefined watermark (the capture
  // threw) FORGETS the old floor: the new base's floor is unknown, and no floor
  // persist may run until the next FULL rebuild records one.
  function setBaseFloor(
    entry: RegistryEntry,
    pk: string,
    watermark: string | undefined,
  ): void {
    if (!isUnboundedWindow(entry)) return;
    if (watermark === undefined) entry.baseFloors?.delete(pk);
    else (entry.baseFloors ??= new Map()).set(pk, watermark);
  }

  // A FULL recompute's persist: REPLACE the row (value, its flight's watermark,
  // the run's read-set, the definition). It cancels an armed floor window
  // SYNCHRONOUSLY, before it enqueues: the window's scoped changes committed
  // before this value's read began, so the value already holds them — and the
  // caller rebuilds the snapshot (and its base floor) only AFTER this resolves,
  // so a window left to fire while the write is in flight would chain a floor
  // link behind it that reads the PRE-replace snapshot and floor and writes
  // them over the fresh row. A floor link already enqueued runs ahead of the
  // replace on the chain, which is harmless. Failure is reported and re-arms a
  // window it cancelled (the row still holds the older value).
  async function persistReplace(
    entry: RegistryEntry,
    pk: string,
    value: unknown,
    watermark: string,
    tablesRead: readonly string[],
  ): Promise<void> {
    const persist = opts.persistSnapshot;
    if (!persist) return;
    const slot = persistSlot(entry.key, pk);
    const armed = armedFloors.get(slot);
    if (armed !== undefined) {
      clearTimeout(armed);
      armedFloors.delete(slot);
    }
    await enqueuePersist(entry, pk, async () => {
      try {
        await persist(entry.key, pk, value, watermark, {
          mode: "replace",
          definition: definitionOf(entry),
          guardTables: tablesRead,
        });
      } catch (err) {
        reportLoaderError(`snapshot persist failed for ${entry.key}`, err);
        if (armed !== undefined) armFloorPersist(entry, pk);
        return;
      }
      const st = statsOf(entry.key);
      st.lastReplaceAt = Date.now();
      st.l2PositionAt = st.lastReplaceAt;
    });
  }

  // Arm the trailing floor window of a persisted alias's (entry, pk) — a scoped
  // drain changed its snapshot. No-op while one is armed (the window is fixed,
  // so a steady stream still persists every `persistWindowMs`). Unref'd: a
  // pending window never holds the process open, and `dropPendingPersists`
  // drops it on shutdown (catch-up replays what it held).
  function armFloorPersist(entry: RegistryEntry, pk: string): void {
    if (!opts.persistSnapshot) return;
    const slot = persistSlot(entry.key, pk);
    if (armedFloors.has(slot)) return;
    const timer = setTimeout(() => {
      armedFloors.delete(slot);
      void enqueuePersist(entry, pk, () => runFloorPersist(entry, pk));
    }, persistWindowMs);
    (timer as { unref?: () => void }).unref?.();
    armedFloors.set(slot, timer);
  }

  // The tables a floor persist's A6 guard judges, and a first INSERT records:
  // a routed entry's route tables (its reads, by construction), else the
  // key's read-set union.
  function floorGuardTables(entry: RegistryEntry): string[] {
    if (entry.routing) {
      return [...new Set(entry.routing.plan.routes.map((r) => r.table))].sort();
    }
    return opts.readSet?.(entry.key) ?? [];
  }

  // One floor persist, run on the chain: the value is reconstructed from the
  // snapshot as it stands NOW (a replace queued ahead of it has already
  // rebuilt it), floored by its base floor. Nothing to write without a
  // snapshot, without a known floor, or once the key stopped persisting.
  async function runFloorPersist(
    entry: RegistryEntry,
    pk: string,
  ): Promise<void> {
    const persist = opts.persistSnapshot;
    const snapshot = entry.snapshots?.get(pk);
    const floor = entry.baseFloors?.get(pk);
    if (!persist || !snapshot || floor === undefined || !isPersisted(entry)) {
      return;
    }
    try {
      await persist(entry.key, pk, valueOfSnapshot(entry, snapshot), floor, {
        mode: "floor",
        definition: definitionOf(entry),
        guardTables: floorGuardTables(entry),
      });
      statsOf(entry.key).lastFloorAt = Date.now();
    } catch (err) {
      reportLoaderError(`snapshot persist failed for ${entry.key}`, err);
    }
  }

  // Reconstruct the FULL value of an alias tuple from its snapshot (ordered id
  // list + canonical-JSON entries). `JSON.parse` of the stored entry round-trips
  // to the identical row object a FULL loader would produce, so the jsonb is
  // byte-identical to a FULL persist. The ONE consumer that reads snapshot
  // bytes back — `snapEncoderFor` guarantees an unbounded-window alias retains
  // strings, and the guard makes a future violation loud instead of a silent
  // corrupt value.
  function valueOfSnapshot(
    entry: RegistryEntry,
    snapshot: Map<string, SnapEntry>,
  ): unknown[] {
    return [...snapshot.values()].map((snap) => {
      if (typeof snap !== "string") {
        throw new Error(
          `[resources] scopedMembership entry "${entry.key}" holds a hashed snapshot — ` +
            "persist reconstruction needs canonical-JSON entries (snapEncoderFor invariant broken)",
        );
      }
      return JSON.parse(snap) as unknown;
    });
  }

  // The snapshot entry representation for THIS resource, decided statically
  // from the definition so it can never flip between seeding and consumption:
  //
  // - `scopedMembership` (unbounded-window alias) entries retain the row's full
  //   canonical JSON — their persisted-incremental path
  //   (`drainMembershipScoped`) reconstructs the FULL value by `JSON.parse` of
  //   the stored entries, so the bytes must be there. (Keying this off
  //   `shouldPersist` instead would race the hook's registration: a snapshot
  //   seeded as hashes before the persist hooks are wired would crash the first
  //   incremental persist.)
  // - Every other keyed entry — including bounded `membership` entries, which
  //   are never persisted — retains a 64-bit content hash: same diff semantics
  //   (entries are only equality-compared), ~16 B/row instead of a value-sized
  //   string Map rebuilt on every recompute. Collision trade documented on
  //   `hashSnapEncoder`.
  function snapEncoderFor(entry: RegistryEntry): SnapEncoder {
    return isUnboundedWindow(entry) ? retainSnapEncoder : hashSnapEncoder;
  }

  // The order-signature fn of a window membership entry, or undefined (point,
  // the alias, non-membership, or a window that never declared one).
  function orderSignatureFnOf(
    entry: RegistryEntry,
  ): ((row: unknown, params: ResourceParams) => string) | undefined {
    const m = entry.membership;
    return m?.kind === "window" ? m.orderSignatureOf : undefined;
  }

  // Compute one row's order signature, fail-safe: a throwing `orderSignatureOf`
  // is reported and yields undefined — callers treat "unknown" as MOVED, so a
  // broken signature costs one extra bounded `windowIdsOf` run, never a stale
  // wire order.
  function safeOrderSig(
    entry: RegistryEntry,
    sigFn: (row: unknown, params: ResourceParams) => string,
    row: unknown,
    params: ResourceParams,
  ): string | undefined {
    try {
      return sigFn(row, params);
      // eslint-disable-next-line promise-safety/no-absorbed-failure -- the error IS reported (reportLoaderError), and undefined is not an absorbable empty: it is the documented "unknown" sentinel the callers treat as MOVED — the fail-safe direction (re-derive the window), never a false "unchanged"
    } catch (err) {
      reportLoaderError(`orderSignatureOf failed for ${entry.key}`, err);
      return undefined;
    }
  }

  // A bounded window's size for `params`, fail-safe: a throwing `limitOf`, or
  // one answering no number (NaN, a non-number from an untyped caller), is
  // reported and yields NaN. Every caller compares it in the doubting
  // direction — `!(size < limit)` ⇒ full, `!(size <= limit)` ⇒ over — so an
  // unknown size makes a window FULL (an exit re-derives; a slice through it
  // is refused), never a false "holds its whole range".
  function safeLimitOf(
    entry: RegistryEntry,
    limitOf: (params: ResourceParams) => number,
    params: ResourceParams,
  ): number {
    try {
      const limit: unknown = limitOf(params);
      if (typeof limit !== "number" || Number.isNaN(limit)) {
        throw new Error(`limitOf answered ${String(limit)}, not a number`);
      }
      return limit;
    } catch (err) {
      reportLoaderError(`limitOf failed for ${entry.key}`, err);
      return Number.NaN;
    }
  }

  // REPLACE the per-member order-signature map for `pk` from a FULL row array.
  // Called wherever a keyed snapshot is seeded/replaced from a full value
  // (sub-ack seed, membership FULL rebuild), so the map's lifecycle is identical
  // to the snapshot's. No-op unless the entry declares `orderSignatureOf`. A row
  // whose signature could not be computed is stored WITHOUT one, so the next
  // refill treats it as moved — fail-safe.
  function reseedOrderSigs(
    entry: RegistryEntry,
    params: ResourceParams,
    value: unknown,
  ): void {
    const pk = paramsKey(params);
    const sigFn = orderSignatureFnOf(entry);
    if (!sigFn || !Array.isArray(value)) return;
    const keyOf = entry.keyOf!;
    const sigs = new Map<string, string>();
    for (const row of value as unknown[]) {
      const s = safeOrderSig(entry, sigFn, row, params);
      if (s !== undefined) sigs.set(keyOf(row), s);
    }
    (entry.orderSigs ??= new Map()).set(pk, sigs);
  }

  // Build the id→entry map for a keyed resource's array value. The identity is
  // computed over the row's canonical JSON string (including nested arrays like
  // an attempt's `conversations`). Shared by `diffKeyed` and `handleSub` so
  // both sides compute identity identically.
  function snapshotOf(
    entry: RegistryEntry,
    value: unknown,
  ): Map<string, SnapEntry> {
    const keyOf = entry.keyOf;
    if (!keyOf) {
      throw new Error(
        `[resources] keyed resource "${entry.key}" missing keyOf`,
      );
    }
    if (!Array.isArray(value)) {
      throw new Error(
        `[resources] keyed resource "${entry.key}" loader must return an array`,
      );
    }
    return buildSnapshot(value, keyOf, snapEncoderFor(entry));
  }

  // Diff the new array `value` against the stored snapshot for `pk`, then REPLACE
  // that snapshot with the freshly computed id→hash map. `hadSnapshot` is false
  // only when there was no prior snapshot entry for `pk` (first notify) — callers
  // send a full update in that case so brand-new clients get a complete base.
  function diffKeyed(
    entry: RegistryEntry,
    pk: string,
    value: unknown,
  ): KeyedDiff {
    const keyOf = entry.keyOf;
    if (!keyOf) {
      throw new Error(
        `[resources] keyed resource "${entry.key}" missing keyOf`,
      );
    }
    if (!Array.isArray(value)) {
      throw new Error(
        `[resources] keyed resource "${entry.key}" loader must return an array`,
      );
    }
    const snapshots = (entry.snapshots ??= new Map());
    const { diff, nextSnapshot } = diffKeyedFull(
      snapshots.get(pk),
      value,
      keyOf,
      snapEncoderFor(entry),
    );
    snapshots.set(pk, nextSnapshot);
    return diff;
  }

  async function flushNotifies(): Promise<void> {
    // Single-active-flush mutex: never overlap two flushes. A notify that lands
    // while a flush is mid-await sets `flushAgain`; the live flush re-drains so
    // mid-flush arrivals are never stranded.
    if (flushRunning) {
      flushAgain = true;
      return;
    }
    flushRunning = true;
    // Stamped with the mutex (not inside the wrapper) so the heartbeat's
    // `flushOpenMs` covers the whole hold, wrapper included.
    flushPassStartedAt = performance.now();
    try {
      // Run the whole drain inside the injected flush wrapper (server:
      // recordEntrySpan("flush", ...)) so each cycle is one `flush` entry and the
      // per-resource `push` loads it triggers nest under it (byParent =
      // head-of-line blocking attribution). Identity passthrough on central.
      if (opts.wrapFlush) await opts.wrapFlush(runFlushCycle);
      else await runFlushCycle();
    } finally {
      flushRunning = false;
      flushPassStartedAt = null;
    }
  }

  // One flush cycle: re-drains while mid-flush notifies set `flushAgain`. Each
  // depth level runs concurrently; a barrier between levels so every cascade
  // merged into a (strictly-deeper) downstream settles before that downstream
  // level drains. A slow loader can no longer head-of-line-block an unrelated
  // entry at the same or an earlier depth.
  async function runFlushCycle(): Promise<void> {
    do {
      // A fresh pass is progress: the previous one settled (see `flushOpenMs`).
      flushPassStartedAt = performance.now();
      flushAgain = false;
      flushScheduled = false;
      rebuildDag();
      for (const level of topoLevels) {
        await Promise.all(level.map(drainEntry));
      }
    } while (flushAgain);
  }

  // Cascade this entry's change into its downstream edges — always FULL: only
  // a legacy (non-membership) entry has downstream (D32), and it recomputes
  // FULL, so there are no row ids to translate. `value`/`valueComputed` feed a
  // value-aware downstream `map`. `sourceTx` (the upstream pending's
  // mutation-ack attribution, minus overflow) threads into every downstream
  // `mergePending`, because a downstream recompute triggered by this cascade
  // also reads post-commit — the ackTx claim holds transitively.
  async function cascadeDownstream(
    entry: RegistryEntry,
    params: ResourceParams,
    value: unknown,
    valueComputed: boolean,
    sourceTx?: ReadonlySet<string>,
    changedAt?: number,
  ): Promise<void> {
    for (const edge of entry.downstream) {
      const down = registry.get(edge.downstreamKey);
      if (!down) continue;
      let derived: ResourceParams[];
      if (edge.routedRecompute) {
        // Only the one upstream tuple the routed entry compiles from; its
        // change moved the SQL, so every tuple's memoized read-set is stale.
        if (paramsKey(params) !== edge.routedRecompute.upstreamPk) continue;
        down.routing?.uses.clear();
        // The tuples a table change would consider (`tracked`, never an
        // O(sockets) scan).
        derived = routedTargets(down).map(([, p]) => p);
      } else if (edge.toSubscribed) {
        derived = subscribedParamsFor(edge.downstreamKey);
      } else if (edge.map) {
        try {
          derived = edge.map(params, valueComputed ? value : undefined);
        } catch (err) {
          reportLoaderError(
            `dependsOn map failed (${entry.key} → ${edge.downstreamKey})`,
            err,
          );
          continue;
        }
      } else {
        derived = [params];
      }
      for (const raw of derived) {
        // A mapped tuple is canonical too, however the map spelled it.
        const dp = canonicalTuple(down, raw);
        mergePending(
          down.pendingNotifies,
          paramsKey(dp),
          dp,
          null,
          undefined,
          sourceTx,
          changedAt,
        );
      }
    }
  }

  // Membership FULL path (drainEntry branches 2 & 3): a membership entry
  // (window / point / the M5 alias) that is either sticky-FULL (an id-less
  // contributor coalesced in) or has NO snapshot yet (first post-boot change,
  // eviction, a race). For a bounded window/point entry this "FULL" is bounded
  // by construction — the entry loader at these params IS the windowed/point
  // read, never an unbounded collection sweep. It FULL-recomputes
  // and SEEDS/REPLACES the per-pk snapshot whenever the value is computed
  // (persisted or subscribed), so the next incremental membership diff
  // has a base. Cascades nothing: a membership entry has no downstream (D32).
  // See research/2026-07-03-global-scoped-membership-m5.md.
  async function drainMembershipFull(
    entry: RegistryEntry,
    pendingEntry: PendingNotify,
    persisted: boolean,
  ): Promise<void> {
    const { params } = pendingEntry;
    const pk = paramsKey(params);
    const version = (entry.versions.get(pk) ?? 0) + 1;
    entry.versions.set(pk, version);
    const subs = subscribersFor(entry.key, pk);
    const owner = snapshotOwner(entry, pk);
    // The snapshot must be maintained whenever it could be needed later: a
    // persisted entry recomputes every change (and survives N→0), and a subscribed
    // entry needs a diff base. With neither there is nothing to seed.
    const needValue = persisted || subs.length > 0;

    let value: unknown;
    // The flight-co-produced commit watermark for the FULL value below (Rule B′
    // — this path's frames fully reconcile the client). It is ALSO the L2
    // persist floor: both stamps describe the same value, so they are the same
    // capture (see the persist below).
    let flightWatermark: string | undefined;
    // Flight-resolved mutation-ack attribution: the pending's sourceTx SEEDS the
    // flight; a joined stale flight resolves the STARTER's (typically absent)
    // seed instead, so a pre-commit value is never stamped with this pending's
    // claim (missed ack safe, false ack structurally impossible).
    let flightAckTx: readonly string[] | undefined;
    let valueComputed = false;
    if (needValue) {
      const seedAckTx = pendingAckTx(pendingEntry);
      try {
        // `notBefore: lastNotifyAt` — this path mints `version` above, so it may
        // not be served by a flight that started before the change it is
        // announcing. Such a flight is superseded, not joined.
        ({
          value,
          watermark: flightWatermark,
          ackTx: flightAckTx,
        } = await (opts.wrapOrigin
          ? opts.wrapOrigin("push", entry.key, () =>
              getResourceValue(
                entry,
                params,
                undefined,
                undefined,
                false,
                seedAckTx,
                pendingEntry.lastNotifyAt,
              ),
            )
          : getResourceValue(
              entry,
              params,
              undefined,
              undefined,
              false,
              seedAckTx,
              pendingEntry.lastNotifyAt,
            )));
        valueComputed = true;
      } catch (err) {
        if (evictOnContractError(entry, params, err)) return;
        reportLoaderError(`loader failed for ${entry.key}`, err);
        broadcastRefusal(subs, entry, params, err);
        // The pending is consumed, so the snapshot may now miss a real member
        // this change admitted — and the router reads membership off it: a
        // quiescent tuple would drop that member's every later value-only
        // change for good. Evict it instead (as at N→0), so the tuple is not
        // quiescent and its next change is a FULL that re-seeds it. A kept
        // (persisted alias) snapshot is the L2 floor persist's source, so it
        // stays.
        if (
          owner !== "kept" &&
          owner !== undefined &&
          snapshotOwner(entry, pk) === owner
        ) {
          evictSnapshot(entry, pk);
        }
        return; // never ship or cascade a torn read — and no ack (no false ack on failure)
      }
      // L2 persist floors the row with the FLIGHT's own watermark — the one its
      // starter captured before its first read — instead of a separately
      // captured one. Sound by the same co-production rule as the wire frames,
      // and one round-trip cheaper: a separate capture taken here could be
      // NEWER than the value it floors (a joined flight read earlier), so
      // catch-up would skip the very commit the value is missing and cold boot
      // would serve it forever. The flight's floor is at worst OLDER, which
      // only means over-replay — harmless by `captureWatermark`'s own contract.
      // Persisted entries are forced FULL, so `flightWatermark` is present
      // whenever the hook is bound; a throwing capture leaves it undefined and
      // the persist is skipped this cycle (the row keeps its prior floor).
      if (persisted && flightWatermark !== undefined) {
        await persistReplace(
          entry,
          pk,
          value,
          flightWatermark,
          persistReadSet(entry.key),
        );
      }
    }

    // The snapshot (and the frames diffed against it) belong to the tracking
    // span this drain started in; a span that ended while the load ran took its
    // snapshot and its subscribers with it (`snapshotOwner`).
    const owns = owner !== undefined && snapshotOwner(entry, pk) === owner;
    if (owns && subs.length > 0 && valueComputed) {
      const hadSnapshot = entry.snapshots?.has(pk) ?? false;
      const { upserts, deletes, order } = diffKeyed(entry, pk, value); // seeds/replaces snapshot
      let frameChars: number;
      if (!hadSnapshot) {
        frameChars = await sendUpdate(
          entry,
          params,
          value,
          version,
          subs,
          flightWatermark,
          flightAckTx,
          pendingEntry.changedAt,
        );
        opts.onPush?.(entry.key, { subscribers: subs.length, changed: true });
      } else {
        // A FULL-recompute keyed delta fully reconciles the client, so it may
        // carry the flight watermark (Rule B′). Scoped deltas never do. The
        // flight-resolved ackTx rides too (a FULL read is post-commit).
        const msg = {
          kind: "delta" as const,
          key: entry.key,
          params,
          upserts,
          deletes,
          order,
          version,
          ...(flightWatermark !== undefined
            ? { watermark: flightWatermark }
            : {}),
          ...(flightAckTx !== undefined && flightAckTx.length > 0
            ? { ackTx: flightAckTx }
            : {}),
          ...(pendingEntry.changedAt !== undefined
            ? { changedAt: pendingEntry.changedAt }
            : {}),
        };
        frameChars = broadcastJson(subs, msg);
        opts.onPush?.(entry.key, {
          subscribers: subs.length,
          changed:
            upserts.length > 0 || deletes.length > 0 || order !== undefined,
        });
      }
      opts.onDelivered?.(
        entry.key,
        performance.now() - pendingEntry.enqueuedAt,
        subs.length,
        frameChars,
      );
    } else if (owns && valueComputed) {
      // Zero subscribers but a value was computed for a snapshot that outlives
      // them (a persisted alias): still seed/replace the snapshot so the next
      // membership diff has a base. An untracked tuple seeds nothing — no
      // drain would keep that snapshot current.
      diffKeyed(entry, pk, value);
    }
    // The order-signature map's lifecycle mirrors the snapshot's: whenever the
    // FULL value replaced the snapshot above, reseed the sigs from it too —
    // and the snapshot's base floor is now this value's flight watermark.
    if (owns && valueComputed) {
      reseedOrderSigs(entry, params, value);
      setBaseFloor(entry, pk, flightWatermark);
    }
  }

  // Membership incremental path (drainEntry branch 4): a membership entry
  // (window — bounded or the M5 alias — or point) with a scoped pending AND a
  // live snapshot. Refills only the requested ids (skipping the loader entirely
  // for a pure DELETE), derives the authoritative order per kind (see the
  // classification block below), reconciles membership via
  // `diffKeyedScopedMembership`, ships an incremental delta (with `order` iff
  // membership changed), and — for a persisted (alias) entry whose snapshot
  // moved — arms the trailing floor persist, which reconstructs the FULL value
  // from the snapshot (byte-identical jsonb to a FULL persist) and floors it by
  // the snapshot's base floor. Any loader/windowIdsOf failure falls back to the
  // FULL path so torn membership is never shipped — bounded for window/point
  // entries by construction, since their loader IS the windowed/point read.
  async function drainMembershipScoped(
    entry: RegistryEntry,
    pendingEntry: PendingNotify,
    persisted: boolean,
  ): Promise<void> {
    const membership = entry.membership!;
    const keyOf = entry.keyOf!;
    const { params } = pendingEntry;
    const pk = paramsKey(params);
    // Never empty: `drainPendings` skips a scoped pending naming no id before
    // it branches here.
    const requestedIds = pendingEntry.affected ?? new Set<string>();
    const deletedIds = pendingEntry.deleted ?? new Set<string>();

    const snapshots = (entry.snapshots ??= new Map());
    const prev = snapshots.get(pk)!; // caller only routes here when a snapshot exists
    // The base floor of `prev` — set in the same synchronous step as every
    // snapshot rebuild, so it describes exactly the base this drain diffs from.
    const prevBase = entry.baseFloors?.get(pk);
    const owner = snapshotOwner(entry, pk);

    // Refill only the requested (op-I ∪ op-U) ids — a pure DELETE runs NO loader.
    let refillRows: unknown[] = [];
    if (requestedIds.size > 0) {
      try {
        const ctx = { affectedIds: [...requestedIds] };
        const { value: v } = await (opts.wrapOrigin
          ? opts.wrapOrigin("push", entry.key, () =>
              getResourceValue(entry, params, ctx),
            )
          : getResourceValue(entry, params, ctx));
        if (!Array.isArray(v)) {
          throw new Error(
            `keyed resource "${entry.key}" loader must return an array`,
          );
        }
        refillRows = v as unknown[];
      } catch (err) {
        if (evictOnContractError(entry, params, err)) return;
        reportLoaderError(`loader failed for ${entry.key}`, err);
        await drainMembershipFull(entry, pendingEntry, persisted); // never ship torn membership
        return;
      }
    }

    // Classify the membership impact of this flush against the prior snapshot:
    //   entered — a refilled id not already a member (a potential entrant; for a
    //             BOUNDED window only `windowIdsOf` can decide whether it truly
    //             enters — it may sort past the tail);
    //   exited  — a requested id the refill omitted (where-flip exit) or a
    //             deleted id that was a member (a leaver; for a FULL bounded
    //             window a leaver frees a slot the new tail row must fill).
    // A pure in-place change (neither) runs NO ids query on ANY kind — the M5
    // cost model. Corollary: an in-place UPDATE never reorders the window until
    // the next membership delta, so a window's ORDER BY must be over
    // update-stable columns (createdAt/pk); the compiler layer documents and
    // owns that contract.
    const refillIds = new Set<string>();
    for (const row of refillRows) refillIds.add(keyOf(row));
    let entered = false;
    for (const id of refillIds) {
      if (!prev.has(id)) {
        entered = true;
        break;
      }
    }
    let exited = false;
    for (const id of requestedIds) {
      if (prev.has(id) && !refillIds.has(id)) {
        exited = true;
        break;
      }
    }
    if (!exited) {
      for (const id of deletedIds) {
        if (prev.has(id)) {
          exited = true;
          break;
        }
      }
    }
    // Order-signature seam: a refilled MEMBER row whose order-relevant
    // projection moved is membership-affecting for a window that declared
    // `orderSignatureOf` — its sort position may have changed, so the window is
    // re-derived (one bounded `windowIdsOf`) and the delta asserts the fresh
    // `order`. Unchanged-signature refills stay on the in-place path (no ids
    // query — the M5 cost model for content-only bumps). A missing stored
    // signature or a failed fresh one is treated as MOVED (fail-safe: one extra
    // bounded ids query, never a stale order). `freshSigs` records every
    // refilled row's signature (undefined = computation failed) for the
    // post-diff map maintenance below.
    const sigFn = orderSignatureFnOf(entry);
    const freshSigs = sigFn ? new Map<string, string | undefined>() : undefined;
    let orderMoved = false;
    if (sigFn && freshSigs) {
      const storedSigs = entry.orderSigs?.get(pk);
      for (const row of refillRows) {
        const id = keyOf(row);
        const fresh = safeOrderSig(entry, sigFn, row, params);
        freshSigs.set(id, fresh);
        if (!prev.has(id)) continue; // an entrant has no stored sig to compare
        if (fresh === undefined || fresh !== storedSigs?.get(id))
          orderMoved = true;
      }
    }

    // Derive the authoritative order per membership kind. `orderedIds`, when
    // set, is the full member id list `diffKeyedScopedMembership` rebuilds the
    // snapshot and wire `order` from.
    let orderedIds: string[] | undefined;
    if (membership.kind === "point") {
      // Point set: membership is the params' explicit id set — no ids query
      // EVER. Entrants append to the prior order (point sets are unordered
      // bags); exits derive from the prior snapshot inside the diff.
      if (entered) {
        orderedIds = [...prev.keys()];
        for (const row of refillRows) {
          const id = keyOf(row);
          if (!prev.has(id)) orderedIds.push(id);
        }
      }
    } else if (membership.bounded) {
      // Bounded window: an entrant candidate or a member whose order signature
      // moved re-derives the window by running `windowIdsOf` (O(window),
      // bounded; the v1 correctness-first choice — a tail-cursor comparison
      // that skips past-the-tail entrants without the ids query is a deferred
      // optimization). It is the entrant arbiter (an id absent from the
      // returned window did not enter; the diff drops it), the tail-pull source
      // (a leaver's freed slot names the new tail id here), and the fresh order
      // authority for a moved member.
      //
      // A leaver needs it only from a FULL window (`prev.size >= limitOf`),
      // which may hide the row that must fill the freed slot. A window holding
      // fewer rows than its limit holds its whole range — nothing sorts past
      // its tail — so an exit pulls nothing in and its order is the prior
      // snapshot's minus the leaver, derived inside the diff with no query and
      // no backfill (the alias's exit path, below). A concurrent insert not
      // yet routed is its own entrant on its own feed event. The test doubts:
      // an unknown size (`safeLimitOf`'s NaN) reads as full.
      const full = !(
        prev.size < safeLimitOf(entry, membership.limitOf, params)
      );
      if (entered || orderMoved || (exited && full)) {
        try {
          orderedIds = await (opts.wrapOrigin
            ? opts.wrapOrigin("push", entry.key, () =>
                runWindowIds(entry, membership, params),
              )
            : runWindowIds(entry, membership, params));
        } catch (err) {
          if (evictOnContractError(entry, params, err)) return;
          reportLoaderError(`windowIdsOf failed for ${entry.key}`, err);
          await drainMembershipFull(entry, pendingEntry, persisted);
          return;
        }
        // Tail backfill: window ids whose row bytes neither the client base
        // (prev — the client holds those rows) nor this refill carries. Without
        // this, `diffKeyedScopedMembership`'s survivor filter would silently
        // drop the pulled-in tail row and the window would shrink. O(entrants).
        // A backfill that comes back short is a torn read (after the diff).
        const missing = orderedIds.filter(
          (id) => !prev.has(id) && !refillIds.has(id),
        );
        if (missing.length > 0) {
          try {
            const ctx = { affectedIds: missing };
            const { value: v } = await (opts.wrapOrigin
              ? opts.wrapOrigin("push", entry.key, () =>
                  getResourceValue(entry, params, ctx),
                )
              : getResourceValue(entry, params, ctx));
            if (!Array.isArray(v)) {
              throw new Error(
                `keyed resource "${entry.key}" loader must return an array`,
              );
            }
            for (const row of v as unknown[]) {
              refillRows.push(row);
              refillIds.add(keyOf(row));
              // A backfilled row is a fresh read too — record its signature so
              // the post-diff map maintenance stores it alongside the refill's.
              if (sigFn && freshSigs)
                freshSigs.set(
                  keyOf(row),
                  safeOrderSig(entry, sigFn, row, params),
                );
            }
          } catch (err) {
            if (evictOnContractError(entry, params, err)) return;
            reportLoaderError(`loader failed for ${entry.key}`, err);
            await drainMembershipFull(entry, pendingEntry, persisted);
            return;
          }
        }
      }
    } else {
      // Unbounded window (the `scopedMembership` alias) — M5: `windowIdsOf`
      // (the orderOf query) runs ONLY when a row ENTERED (an entrant needs
      // authoritative placement) or, for an alias that declared
      // `orderSignatureOf`, when a member's order signature MOVED (its position
      // may have changed — the same seam as a bounded window's); an exit-only
      // or in-place change derives its order from the prior snapshot inside the
      // diff, so no query runs. No backfill: an unbounded order lists no id
      // outside prev ∪ refill (a concurrent-insert straggler is dropped by the
      // diff and healed by its own feed event — the recorded M5 semantics).
      if (entered || orderMoved) {
        try {
          orderedIds = await (opts.wrapOrigin
            ? opts.wrapOrigin("push", entry.key, () =>
                runWindowIds(entry, membership, params),
              )
            : runWindowIds(entry, membership, params));
        } catch (err) {
          if (evictOnContractError(entry, params, err)) return;
          reportLoaderError(`orderOf failed for ${entry.key}`, err);
          await drainMembershipFull(entry, pendingEntry, persisted);
          return;
        }
      }
    }

    const { upserts, deletes, order, nextSnapshot } = diffKeyedScopedMembership(
      prev,
      refillRows,
      { requestedIds, deletedIds, orderedIds },
      keyOf,
      snapEncoderFor(entry),
    );
    // A torn read: the bounded window the ids query named holds an id the diff
    // could not keep — no bytes for it (the backfill target was deleted, or its
    // where flipped, after `windowIdsOf` read it), or an exit `windowIdsOf`
    // saw back in range. Recording that snapshot would leave it short of its
    // range while a row in range stays hidden — and a window holding fewer
    // rows than its limit is trusted to hold its whole range (exits stop
    // re-deriving), so nothing would ever pull that row back in. The snapshot
    // never records less than the window its query named: one bounded FULL
    // read rebuilds a consistent one instead. (The alias keeps its recorded
    // M5 semantics: a straggler is healed by its own feed event.)
    if (
      membership.kind === "window" &&
      membership.bounded &&
      orderedIds !== undefined &&
      nextSnapshot.size < orderedIds.length
    ) {
      await drainMembershipFull(entry, pendingEntry, persisted);
      return;
    }
    // The tracking span this drain started in ended while it read: its snapshot
    // was evicted and its subscribers left (`snapshotOwner`). Writing
    // `nextSnapshot` back would resurrect a base nothing routes to, so the diff
    // is dropped whole — no snapshot, no frame, no ack (whoever asked for one is
    // gone). Nothing cascades from a membership entry (D32).
    if (snapshotOwner(entry, pk) !== owner) return;
    // A sub-ack may have re-seeded the snapshot (and raised its base floor to
    // its own read's watermark) while this drain read: its `versions ===
    // baseVersion` test holds until this drain bumps the version below. The
    // snapshot written here is still `prev` + this refill, so its floor is
    // `prev`'s — keeping the sub-ack's would claim a newer base than the value
    // has, and a floor persist into a missing row (or under another writer's
    // higher position) would then skip the commits in between on catch-up.
    const rebasedUnder = snapshots.get(pk) !== prev;
    snapshots.set(pk, nextSnapshot);
    if (rebasedUnder) setBaseFloor(entry, pk, prevBase);

    // Maintain the order-signature map in lockstep with the snapshot: refilled
    // rows take their fresh signature, carried-over members keep the stored one,
    // ids that left the snapshot drop out. A refilled row whose fresh signature
    // failed is stored WITHOUT one, so the next refill treats it as moved.
    if (sigFn && freshSigs) {
      const storedSigs = entry.orderSigs?.get(pk);
      const nextSigs = new Map<string, string>();
      for (const id of nextSnapshot.keys()) {
        const s = freshSigs.has(id) ? freshSigs.get(id) : storedSigs?.get(id);
        if (s !== undefined) nextSigs.set(id, s);
      }
      (entry.orderSigs ??= new Map()).set(pk, nextSigs);
    }

    // Ship the delta + bump the version only on a real change. `order` present
    // counts as a change on its own: the diff only returns it when the rebuilt
    // snapshot's membership/order actually differs from the prior one (e.g. a
    // member whose order signature moved past the tail leaves via `order` with
    // no surviving upsert and no `deletes` entry) — the client must receive the
    // frame or its array drifts from the mutated server snapshot.
    const changed =
      upserts.length > 0 || deletes.length > 0 || order !== undefined;
    // Persisted: the snapshot moved, so arm the trailing floor window — ONE
    // floor persist of the value reconstructed from the snapshot, floored by
    // its base floor (never a capture taken here: the refill read only the
    // requested ids, so a drain-time watermark could pass over a commit this
    // tuple has not been routed yet). An unchanged snapshot owes L2 nothing.
    if (persisted && changed) armFloorPersist(entry, pk);
    const subs = subscribersFor(entry.key, pk);
    if (changed) {
      const version = (entry.versions.get(pk) ?? 0) + 1;
      entry.versions.set(pk, version);
      if (subs.length > 0) {
        // Membership-scoped deltas stamp the PENDING's sourceTx directly:
        // scoped/backfill refills are ctx loads, which never coalesce (they
        // bypass the read inflight), so no stale-flight adoption is needed —
        // and Rule B′ is untouched (still no watermark; ackTx claims only "the
        // listed transactions' rows were re-read", never snapshot completeness).
        const ackTx = pendingAckTx(pendingEntry);
        const msg = {
          kind: "delta" as const,
          key: entry.key,
          params,
          upserts,
          deletes,
          order,
          version,
          ...(ackTx !== undefined ? { ackTx } : {}),
          ...(pendingEntry.changedAt !== undefined
            ? { changedAt: pendingEntry.changedAt }
            : {}),
        };
        const frameChars = broadcastJson(subs, msg);
        opts.onDelivered?.(
          entry.key,
          performance.now() - pendingEntry.enqueuedAt,
          subs.length,
          frameChars,
        );
      }
    } else {
      // Net-zero recompute (an entrant sorting past the tail, a window-boundary
      // skip): no frame, no version bump — but the writer's ack must not hang
      // on it. Subscribers that asked for acks get the standalone ack frame.
      broadcastAckOnly(entry, pendingEntry);
    }
    // An empty diff is still a recorded no-op push (changed:false) to any subscriber.
    if (subs.length > 0) {
      opts.onPush?.(entry.key, { subscribers: subs.length, changed });
    }
  }

  // Drain one entry's pending notifies: load (await), send frames, cascade.
  // Begins with a synchronous snapshot+clear of pending and a debounce-timer
  // cancel, so concurrent sibling entries in the same level never tear each
  // other's state and every cascade this entry emits has settled before the
  // next (deeper) level reads it. The per-pk loop stays sequential — the version
  // and keyed snapshot for a single (key,pk) must advance monotonically.
  async function drainEntry(entry: RegistryEntry): Promise<void> {
    if (entry.pendingNotifies.size === 0 && entry.pendingAcks.size === 0) {
      return;
    }
    const pending = Array.from(entry.pendingNotifies.values());
    entry.pendingNotifies.clear();
    const owedAcks = Array.from(entry.pendingAcks.values());
    entry.pendingAcks.clear();
    // Piggyback: this entry's pending is being drained now (possibly by a flush
    // some other resource scheduled), so cancel any armed debounce timer — it
    // would otherwise fire redundantly on an already-empty pending map.
    if (entry.debounceTimer !== undefined) {
      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = undefined;
    }
    // The acks owed to skipped tuples (see `PendingAck`): folded into the
    // tuple's real pending when this drain has one — its frame (or its own ack)
    // then carries them — and otherwise sent right here, as a standalone ack,
    // before any persisted or membership branch can see the tuple.
    const byPk = new Map<string, PendingNotify>();
    for (const p of pending) byPk.set(paramsKey(p.params), p);
    for (const owed of owedAcks) {
      const real = byPk.get(paramsKey(owed.params));
      if (!real) {
        broadcastAck(
          entry,
          owed.params,
          owed.overflow ? undefined : [...owed.xids],
        );
      } else if (owed.overflow) {
        real.sourceTxOverflow = true;
        real.sourceTx = undefined;
      } else {
        unionSourceTx(real, owed.xids);
      }
    }
    if (pending.length === 0) return;
    // Mark the taken pks as draining until the whole drain settles (see
    // `RegistryEntry.draining`): coarser than per-pk, which only ever makes the
    // router deliver a value-role change it could have dropped — never the
    // reverse.
    for (const pk of byPk.keys()) entry.draining.add(pk);
    try {
      await resolveReverseRoutes(entry, pending);
      await drainPendings(entry, pending);
    } finally {
      for (const pk of byPk.keys()) entry.draining.delete(pk);
    }
  }

  // Resolve the reverse routes the router left on these pendings (see
  // `PendingNotify.unresolved`): once per (entry, route, flush), over the union of
  // every pending's changed values, so a burst of lookup writes costs one query.
  // `within` bounds the answer to the ids a tuple can hold — its point set, or
  // its members when it reads the route in the value role (null = unbounded, a
  // membership reader); bounded and unbounded readers resolve as two groups (at
  // most two queries — see below). The answer lands in the SAME pending as
  // the change's other routes, so its ack leaves only after all of them.
  // `"over-cap"` or a throw recomputes the readers FULL (a throw is reported).
  // Runs under the `cascade` origin: it is an ids-translation read, not part of the value (and not in its read-set).
  async function resolveReverseRoutes(
    entry: RegistryEntry,
    pending: readonly PendingNotify[],
  ): Promise<void> {
    const groups = new Map<
      string,
      {
        route: ReverseRoute;
        changed: Set<string>;
        readers: Array<{
          pending: PendingNotify;
          within: ReadonlySet<string> | null;
        }>;
      }
    >();
    for (const p of pending) {
      const unresolved = p.unresolved;
      if (!unresolved) continue;
      p.unresolved = undefined;
      if (p.affected === null) continue; // FULL already covers every host
      for (const [routeId, u] of unresolved) {
        const within = reverseWithin(entry, p, u.membership);
        if (within === "full") {
          p.affected = null;
          p.deleted = undefined;
          break;
        }
        let group = groups.get(routeId);
        if (!group) {
          group = { route: u.route, changed: new Set(), readers: [] };
          groups.set(routeId, group);
        }
        for (const v of u.changed) group.changed.add(v);
        group.readers.push({ pending: p, within });
      }
    }
    for (const group of groups.values()) {
      const readers = group.readers.filter((r) => r.pending.affected !== null);
      if (readers.length === 0) continue;
      const resolve = async (
        bound: ReadonlySet<string> | null,
      ): Promise<readonly string[] | "over-cap" | "failed"> => {
        const run = () =>
          group.route.map.resolve(
            [...group.changed],
            bound,
            REVERSE_RESOLVE_CAP,
          );
        try {
          return await (opts.wrapOrigin
            ? opts.wrapOrigin("cascade", entry.key, run)
            : run());
        } catch (err) {
          reportLoaderError(
            `reverse route "${group.route.id}" failed for ${entry.key}`,
            err,
          );
          return "failed";
        }
      };
      const land = (
        answer: readonly string[] | "over-cap" | "failed",
        onto: typeof readers,
      ): void => {
        for (const { pending: p, within: own } of onto) {
          if (p.affected === null) continue;
          if (answer === "over-cap" || answer === "failed") {
            p.affected = null; // the reader recomputes FULL — bounded for a window
            p.deleted = undefined;
            continue;
          }
          for (const id of answer) {
            if (own === null || own.has(id)) p.affected.add(id);
          }
        }
      };
      // Two groups, so one unbounded (membership) reader does not unbound the
      // rest: the unbounded answer, when it fits the cap, is a superset every
      // bounded reader cuts to its own ids — one query. Only when it is over
      // the cap do the bounded readers probe again, within the union of their
      // own ids, instead of all recomputing FULL beside the unbounded ones.
      const unbounded = readers.filter((r) => r.within === null);
      const bounded = readers.filter((r) => r.within !== null);
      let pendingBounded = bounded;
      if (unbounded.length > 0) {
        const answer = await resolve(null);
        land(answer, unbounded);
        if (answer !== "over-cap") {
          land(answer, bounded);
          pendingBounded = [];
        }
      }
      if (pendingBounded.length > 0) {
        const within = new Set<string>();
        for (const r of pendingBounded) {
          for (const id of r.within ?? []) within.add(id);
        }
        land(await resolve(within), pendingBounded);
      }
    }
  }

  // The ids one pending's answer from a reverse route is bounded to, by the
  // same rule as `shapeForTuple`: a tuple that reads the route only in the value
  // role resolves within its members (its snapshot's keys — for a point tuple,
  // those of its own ids), since a value-role change cannot admit anyone. A
  // membership-role reader is bounded only by what could enter: a point tuple's
  // own id set, or nothing (null) for a window / alias. With no snapshot to
  // read members off, a point tuple falls back to its id set and a window to
  // unbounded. `"full"` when a point set cannot be decoded — its refill would
  // otherwise admit ids outside the set.
  function reverseWithin(
    entry: RegistryEntry,
    pending: PendingNotify,
    membershipRole: boolean,
  ): ReadonlySet<string> | null | "full" {
    const membership = entry.membership;
    const snapshot = membershipRole
      ? undefined
      : entry.snapshots?.get(paramsKey(pending.params));
    if (membership?.kind === "point") {
      let ids: Set<string>;
      try {
        ids = new Set(membership.idsOf(pending.params));
      } catch (err) {
        reportLoaderError(`idsOf failed for ${entry.key}`, err);
        return "full";
      }
      return snapshot
        ? new Set([...ids].filter((id) => snapshot.has(id)))
        : ids;
    }
    return snapshot ? new Set(snapshot.keys()) : null;
  }

  // Is `entry` L2-persisted? The drain's gate, and the router's reason to keep
  // the `{}` tuple current with nobody subscribed.
  function isPersisted(entry: RegistryEntry): boolean {
    return (
      !entry.externalSource &&
      !membershipBounded(entry) &&
      (opts.shouldPersist?.(entry.key) ?? false)
    );
  }

  // The per-pk half of `drainEntry`, over the pendings it took.
  async function drainPendings(
    entry: RegistryEntry,
    pending: readonly PendingNotify[],
  ): Promise<void> {
    // L2: persisted entries (boot-critical, DB-backed) always recompute FULL and
    // persist their value to `live_state_snapshot` — even with zero subscribers —
    // so cold boot reads a fresh snapshot instead of a from-scratch rebuild. A
    // scoped partial is never persisted (§3.6/§6.7): the legacy path below is
    // FULL-only, and a persisted alias's scoped drains write a floor persist.
    // Gated on `!entry.externalSource` defensively (the injected `shouldPersist`
    // already excludes external sources, but a runtime check makes the invariant
    // hold regardless of how the hook is backed), and on `!membershipBounded` —
    // a bounded-membership entry (bounded window / point) is structurally
    // excluded from persistence, read off the definition (never by name): its
    // value is a per-subscription bounded working set, not a collection
    // materialization. See
    // research/2026-06-22-global-live-state-l2-persisted-materialization.md §3.3
    // and research/2026-07-18-global-bounded-working-set-resource-contract.md.
    const persisted = isPersisted(entry);

    for (const pendingEntry of pending) {
      const { params, affected } = pendingEntry;
      const pk = paramsKey(params);
      // A SCOPED pending (membership entries only — A25) that names nothing —
      // no row to refill, none deleted — changed nothing for this tuple: a
      // reverse route that resolved to no host. Skip it before the membership
      // branches (a FULL drain would reload the whole value): no version bump,
      // no frame — only the standalone ack to the subscribers that asked for
      // one.
      if (
        affected !== null &&
        affected.size === 0 &&
        (pendingEntry.deleted?.size ?? 0) === 0
      ) {
        broadcastAckOnly(entry, pendingEntry);
        continue;
      }
      // A membership entry (bounded window / point / the M5 alias) runs the
      // incremental membership path instead of the legacy FULL branch.
      // Branch 2/3 (FULL: sticky-FULL `affected === null`, or no snapshot yet)
      // vs branch 4 (incremental, snapshot present). For a window/point entry
      // the FULL branch is bounded by construction — its loader IS the
      // windowed/point read at these params. See the M5 plan doc.
      if (entry.membership) {
        const hasSnapshot = entry.snapshots?.get(pk) !== undefined;
        if (affected === null || !hasSnapshot) {
          await drainMembershipFull(entry, pendingEntry, persisted);
        } else {
          await drainMembershipScoped(entry, pendingEntry, persisted);
        }
        continue;
      }
      // The legacy path: a push / invalidate entry, recomputed FULL (`affected`
      // is always null here — A25). A keyed entry is always a membership entry;
      // the one exception is a deferred keyed placeholder before its
      // bind, which has no loader to run either — reported, never guessed at.
      if (entry.mode === "keyed") {
        reportLoaderError(
          `drain of keyed resource ${entry.key} without a membership`,
          new Error(
            `"${entry.key}" is keyed but has no membership — a deferred resource drained before bindDeferredResources()?`,
          ),
        );
        continue;
      }
      const version = (entry.versions.get(pk) ?? 0) + 1;
      entry.versions.set(pk, version);
      const subs = subscribersFor(entry.key, pk);

      // Compute value once if either a subscriber (push mode) or any
      // value-aware downstream `map` needs it. For invalidate-mode upstreams
      // we still compute when a map wants it — rare today, acceptable cost.
      // L2: a persisted entry ALWAYS needs the value so it can be written to
      // the snapshot, even when no tab is subscribed.
      const hasValueAwareDownstream = entry.downstream.some(
        (d) => d.map !== undefined,
      );
      const needValue =
        persisted ||
        (entry.mode === "push" && subs.length > 0) ||
        hasValueAwareDownstream;
      let value: unknown;
      // Flight-co-produced commit watermark (Rule B′), and the L2 persist floor
      // below — one capture, because both stamps describe the same value.
      let flightWatermark: string | undefined;
      // Flight-resolved mutation-ack attribution: the pending's sourceTx seeds
      // the flight; a joined stale (pre-commit) flight resolves the STARTER's
      // seed instead — missed ack safe, false ack impossible.
      let flightAckTx: readonly string[] | undefined;
      let valueComputed = false;
      if (needValue) {
        const seedAckTx = pendingAckTx(pendingEntry);
        try {
          // Origin = the push/cascade flush: re-establishes an entry context
          // (this runs in a bare microtask with no ambient context) so the
          // loader span attributes to this `push` instead of `parent: null`.
          // `notBefore: lastNotifyAt` — this drain minted `version` above, so a
          // flight that started before the change it is announcing must be
          // superseded rather than joined.
          ({
            value,
            watermark: flightWatermark,
            ackTx: flightAckTx,
          } = await (opts.wrapOrigin
            ? opts.wrapOrigin("push", entry.key, () =>
                getResourceValue(
                  entry,
                  params,
                  undefined,
                  undefined,
                  false,
                  seedAckTx,
                  pendingEntry.lastNotifyAt,
                ),
              )
            : getResourceValue(
                entry,
                params,
                undefined,
                undefined,
                false,
                seedAckTx,
                pendingEntry.lastNotifyAt,
              )));
          valueComputed = true;
        } catch (err) {
          if (evictOnContractError(entry, params, err)) continue;
          reportLoaderError(`loader failed for ${entry.key}`, err);
          broadcastRefusal(subs, entry, params, err);
          // Skip sending and cascading on loader failure — otherwise we'd
          // invalidate downstream state based on a torn read. Never persist on
          // the failure path. No ack either — a failed recompute never proved
          // anything was re-read.
          continue;
        }

        // L2: persist the value on loader SUCCESS only, floored by the
        // FLIGHT's own watermark — captured by that flight's starter before its
        // first read, so it describes exactly the value being persisted. A
        // separately captured floor could be NEWER than a joined flight's value,
        // and catch-up (which replays only `xid >= watermark`) would then skip
        // the very commit the value is missing — a stale cold boot that survives
        // restarts. The flight's floor is at worst older, which only over-replays
        // (harmless per `captureWatermark`'s contract). A throwing capture
        // leaves it undefined and the persist is skipped this cycle (the row
        // keeps its prior, older floor) while subscribers are still served.
        // Persist failure is reported but does not block the send/cascade.
        if (persisted && flightWatermark !== undefined) {
          // The loader has already run (via `getResourceValue` above), so its
          // per-run read-set is captured — `persistReadSet` returns the tables THIS
          // run read (replace, self-healing), persisted alongside the value so the
          // next cold boot routes catch-up by the current set without a loader run.
          await persistReplace(
            entry,
            pk,
            value,
            flightWatermark,
            persistReadSet(entry.key),
          );
        }
      }

      // The delivered frame's size (0 while nothing value-carrying was sent) —
      // the `frameChars` measure of this delivery.
      let frameChars = 0;
      if (subs.length > 0) {
        if (entry.mode === "invalidate") {
          const msg = {
            kind: "invalidate" as const,
            key: entry.key,
            params,
            version,
          };
          frameChars = broadcastJson(subs, msg);
        } else {
          frameChars = await sendUpdate(
            entry,
            params,
            value,
            version,
            subs,
            flightWatermark,
            flightAckTx,
            pendingEntry.changedAt,
          );
        }
      }

      // Delivery latency (enqueue → ws.send) charged to this resource under the
      // active `flush` entry (server: recordSpan("push", `deliver:<key>`)). Only
      // when a subscriber actually received a frame. Identity no-op on central.
      if (subs.length > 0) {
        opts.onDelivered?.(
          entry.key,
          performance.now() - pendingEntry.enqueuedAt,
          subs.length,
          frameChars,
        );
      }

      await cascadeDownstream(
        entry,
        params,
        value,
        valueComputed,
        cascadeSourceTx(pendingEntry),
        pendingEntry.changedAt,
      );
    }
  }

  // --- WS handler ---

  const notificationsWsHandler: WsHandler = {
    open(ws) {
      sockets.set(ws, { ws, subs: new Map() });
      // `flushOpenMs`: how long the running flush pass has been open (0 when
      // idle) — see `flushPassStartedAt`. Additive on the wire: an older client
      // ignores it, and the client reads a ping without it as 0.
      const timer = setInterval(
        () => sendJson(ws, { kind: "ping", flushOpenMs: flushOpenMs() }),
        HEARTBEAT_MS,
      );
      heartbeats.set(ws, timer);
    },
    message(ws, raw) {
      const state = sockets.get(ws);
      if (!state) return;
      let msg: unknown;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
        return;
      }
      if (!msg || typeof msg !== "object") return;
      // Each frame is read as the vocabulary declares its `op`
      // (`ReceivedFrame`): untrusted, every field optional, and nothing a tab
      // was never declared to send — a new field the runtime reads is an edit
      // to the vocabulary, which moves `PROTOCOL`. An unknown op is ignored.
      //
      // Canonical from here on (see `canonicalTuple`): a frame's params name the
      // tuple the rest of the runtime keys. Every frame sent back echoes that
      // canonical tuple, so a sender that did NOT canonicalize (live-state's
      // client does) would match none of them — reported, once per key.
      switch ((msg as { op?: unknown }).op) {
        case "sub": {
          const m = msg as ReceivedFrame<"sub">;
          m.params = canonicalFor(m.key, m.params);
          void handleSub(state, m);
          return;
        }
        case "sub-batch": {
          // One whole-set replay for ONE tab. `complete: true` additionally
          // reconciles — releases every sub that tab previously held on this
          // socket and did not restate.
          const m = msg as ReceivedFrame<"sub-batch">;
          if (Array.isArray(m.entries)) {
            for (const e of m.entries) {
              if (e !== null && typeof e === "object") {
                e.params = canonicalFor(e.key, e.params);
              }
            }
          }
          handleSubBatch(state, m);
          return;
        }
        case "unsub": {
          const m = msg as ReceivedFrame<"unsub">;
          m.params = canonicalFor(m.key, m.params);
          handleUnsub(state, m);
          return;
        }
        case "sub-acks": {
          const m = msg as ReceivedFrame<"sub-acks">;
          m.params = canonicalFor(m.key, m.params);
          handleSubAcks(state, m);
          return;
        }
        case "unsub-tab": {
          // Best-effort tab departure (pagehide): release everything this tab
          // holds on this socket. Subs other tabs still hold are untouched.
          const m = msg as ReceivedFrame<"unsub-tab">;
          releaseTabSubs(state, typeof m.tabId === "string" ? m.tabId : "");
          return;
        }
      }
    },
    close(ws) {
      const timer = heartbeats.get(ws);
      if (timer) clearInterval(timer);
      heartbeats.delete(ws);
      const state = sockets.get(ws);
      if (state) {
        // Release once per (key, pk) regardless of how many tabs held it — the
        // socket-level refcount was bumped once per pk. Legacy `""`-bucket subs
        // release here too (their only teardown path).
        for (const [key, inner] of state.subs) {
          for (const [pk, rec] of inner)
            releaseSubRefcount(key, pk, rec.params);
        }
      }
      sockets.delete(ws);
    },
  };

  // Socket-level sub registration bookkeeping, shared by `handleSub` and
  // `handleSubBatch`. Fully synchronous: creates/updates the per-socket
  // `SocketSubRecord` (tagging the holding tab), and bumps `entry.subCounts` only
  // on the socket-level 0→1 (pk record created). Returns whether this
  // registration was the GLOBAL 0→1 transition — the caller then owes the
  // (possibly async) `onFirstSubscribe` exactly once. `acks` is the frame's
  // restated ack flag for this tab (see `SocketSubRecord.ackTabs`).
  //
  // The GLOBAL 0→1 also opens a new TRACKING SPAN, with a fresh version. A tuple
  // is tracked only while subscribed: the change feed routes to subscribed
  // tuples (a param'd one with none admits nothing), and a `whileSubscribed`
  // watcher stops at the last unsubscribe. So a version minted before this
  // span — last acked to a tab before its socket dropped, or read over HTTP
  // while nobody subscribed — says nothing about changes during the gap. The
  // bump makes every such version lower than every version of this span, so
  // the short-circuit below (`handleSub` / `handleSubBatch`) can only match a
  // version this span minted: a first subscriber is never `up-to-date`, and a
  // later one only when nothing changed since its version, all of it tracked.
  function registerSubOnSocket(
    state: SocketState,
    entry: RegistryEntry,
    pk: string,
    params: ResourceParams,
    tabId: string,
    acks: boolean,
  ): { firstGlobal: boolean } {
    let inner = state.subs.get(entry.key);
    if (!inner) {
      inner = new Map();
      state.subs.set(entry.key, inner);
    }
    let rec = inner.get(pk);
    const alreadyHeldBySocket = rec !== undefined;
    if (!rec) {
      rec = { params, tabs: new Set<string>(), ackTabs: new Set<string>() };
      inner.set(pk, rec);
    }
    rec.tabs.add(tabId);
    if (acks) rec.ackTabs.add(tabId);
    else rec.ackTabs.delete(tabId);
    if (alreadyHeldBySocket) return { firstGlobal: false };
    const prev = entry.subCounts.get(pk) ?? 0;
    entry.subCounts.set(pk, prev + 1);
    if (prev === 0) {
      entry.versions.set(pk, (entry.versions.get(pk) ?? 0) + 1);
      entry.tracked.set(pk, params);
      entry.spans.set(pk, ++lastSpan);
    }
    return { firstGlobal: prev === 0 };
  }

  // ── Seeded derivation ───────────────────────────────────────────────────
  //
  // A paged read splits and merges its pages, and each new page's rows are —
  // wholly or partly — a slice of pages the client and this server already
  // hold (research/2026-10-09-global-live-key-range-pages-v2.md §4.4). So a
  // fresh `sub` may carry `derive: { id, from: DeriveSource[] }`, and when every
  // source is QUIESCENT at the version the client sliced and the slices are
  // complete for the new range, the new tuple's snapshot is copied from them —
  // no load, and a `sub-ack` with no value: the client adopts the slice it
  // holds. Otherwise the sub falls back to today's full load; the client takes
  // either answer.
  //
  // Why the copy is the new tuple's truth: a quiescent source (subscribed, a
  // snapshot of its own span, no pending, not draining, its version the one
  // the client sliced) holds every change routed to it so far — and the client
  // holds exactly that snapshot at that version. Every change routed from the
  // registration on reaches the new tuple too (`handleSub` derives in the same
  // synchronous step as it registers), and drains against the copy. A window
  // is a prefix of its range, so a slice ending at a row of it is complete up
  // to that row; one through its end only when the source is not full. The
  // rows the new tuple's range holds beyond the slices are the client's claim
  // (the cuts it encoded in the new params): the runtime is key-agnostic and
  // cannot check a range, only that the slices fit the window (`limitOf`).
  //
  // Only under this server's frame vocabulary: the sub's `protocol` must be
  // `PROTOCOL`. A tab of another vocabulary (an older bundle left open across
  // a deploy, or one that predates the field) may mean something else by its
  // `derive`, or read the derived ack differently — it loads (`protocol-skew`).
  //
  // Only a bounded window that states its `familyOf`: never
  // persisted, so no base floor to carry (an L2 floor must describe a FULL
  // read, which nothing here did), and the hash encoder on both sides. The
  // order signatures are copied with the rows, which holds only within one
  // query, whose tuples order alike — so every source must be of the new
  // tuple's family (`familyOf`), checked here rather than trusted.

  /** A `derive` field, its sources canonical — `null` when it does not parse. */
  function derivationOf(key: string, raw: unknown): Derivation | null {
    if (raw === null || typeof raw !== "object") return null;
    const { id, from } = raw as { id?: unknown; from?: unknown };
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > DERIVE_MAX_ID
    ) {
      return null;
    }
    if (
      !Array.isArray(from) ||
      from.length === 0 ||
      from.length > DERIVE_MAX_SOURCES
    ) {
      return null;
    }
    const out: DeriveSource[] = [];
    for (const s of from as unknown[]) {
      if (s === null || typeof s !== "object") return null;
      const { params, version, after, until } = s as Record<string, unknown>;
      if (
        params === null ||
        typeof params !== "object" ||
        Array.isArray(params) ||
        typeof version !== "number" ||
        (after !== null && typeof after !== "string") ||
        (until !== null && typeof until !== "string")
      ) {
        return null;
      }
      out.push({
        params: canonicalFor(key, params as ResourceParams)!,
        version,
        after,
        until,
      });
    }
    return { id, from: out };
  }

  /**
   * Derive the freshly registered tuple `pk` from the sources `raw` names:
   * its snapshot (and order signatures) copied from theirs, answering the
   * derivation to echo — or why it falls back to a load. Synchronous: the
   * caller registered `pk` in the same step.
   */
  function deriveSub(
    entry: RegistryEntry,
    pk: string,
    params: ResourceParams,
    raw: unknown,
  ): { id: string } | DeriveRefusal {
    const m = entry.membership;
    if (
      entry.mode !== "keyed" ||
      m?.kind !== "window" ||
      !m.bounded ||
      m.familyOf === undefined ||
      entry.revalidate
    ) {
      return "not-derivable";
    }
    const derivation = derivationOf(entry.key, raw);
    if (derivation === null) {
      reportLoaderError(
        `malformed derive for ${entry.key}`,
        new Error(`a sub carried derive=${JSON.stringify(raw)}`),
      );
      return "malformed";
    }
    const family = m.familyOf(params);
    const snapshots = (entry.snapshots ??= new Map());
    const rows: [string, SnapEntry][] = [];
    const seen = new Set<string>();
    const sigs = new Map<string, string>();
    for (const s of derivation.from) {
      const spk = paramsKey(s.params);
      const tracked = entry.tracked.get(spk);
      const snap = snapshots.get(spk);
      if (
        spk === pk ||
        tracked === undefined ||
        !entry.spans.has(spk) ||
        snap === undefined
      ) {
        return "source-not-held";
      }
      // Its rows are copied in its order, its signatures cut by its own
      // order: only a range of the same query is a slice of this one's.
      if (m.familyOf(tracked) !== family) return "foreign-source";
      if (entry.pendingNotifies.has(spk) || entry.draining.has(spk)) {
        return "source-busy";
      }
      if ((entry.versions.get(spk) ?? 0) !== s.version) return "source-moved";
      // The snapshot's iteration order IS the window order (every write
      // rebuilds it from the wire order — `diffKeyedScopedMembership`).
      const order = [...snap.keys()];
      const from = s.after === null ? 0 : order.indexOf(s.after) + 1;
      const to = s.until === null ? order.length : order.indexOf(s.until) + 1;
      if (from === 0 && s.after !== null) return "slice";
      if (to === 0 && s.until !== null) return "slice";
      if (to < from) return "slice";
      // Doubting, like the drain's `full`: an unknown size reads as full.
      if (
        s.until === null &&
        !(order.length < safeLimitOf(entry, m.limitOf, tracked))
      ) {
        return "source-full";
      }
      const sourceSigs = entry.orderSigs?.get(spk);
      for (const id of order.slice(from, to)) {
        if (seen.has(id)) return "overlap";
        seen.add(id);
        rows.push([id, snap.get(id)!]);
        const sig = sourceSigs?.get(id);
        if (sig !== undefined) sigs.set(id, sig);
      }
    }
    if (!(rows.length <= safeLimitOf(entry, m.limitOf, params))) {
      return "over-limit";
    }
    snapshots.set(pk, new Map(rows));
    // A row the source held no signature for stays without one: the next
    // refill of it re-derives the order (fail-safe, as everywhere).
    if (orderSignatureFnOf(entry))
      (entry.orderSigs ??= new Map()).set(pk, sigs);
    return { id: derivation.id };
  }

  // `m.derive` is a seeded derivation (see `deriveSub`), on a fresh `sub`
  // only, read only under this server's `PROTOCOL` (`m.protocol`).
  async function handleSub(
    state: SocketState,
    m: ReceivedFrame<"sub">,
  ): Promise<void> {
    const { id, key, params = {}, etag: clientEtag } = m;
    if (!key) return;
    const build = typeof m.build === "string" ? m.build : undefined;
    const entry = registry.get(key);
    if (!entry) {
      sendJson(state.ws, {
        kind: "sub-error",
        id,
        key,
        params,
        reason: "unknown-key",
        verdict: unknownKeyVerdict(build),
      });
      return;
    }
    // The params gate — before authorize and before the sub registers, so a
    // refused sub leaves no trace a push could rerun.
    if (refuseSubParams(state.ws, entry, id, params, build)) return;
    // Subscription-authorization seam (deferred; single-instance-per-user — see
    // research/2026-07-02-global-adr-single-instance-per-user.md). Runs before
    // any side effect (refcount bump, onFirstSubscribe, loader read) so a refused
    // sub leaves no trace. No resource declares `authorize` today — the sole
    // trusted caller of the one-instance-per-user model is always allowed — so
    // for every shipped resource this branch is skipped entirely. A throwing
    // authorize fails CLOSED (report + reject) rather than leaking the value.
    if (entry.authorize) {
      let allowed: boolean;
      try {
        allowed = await entry.authorize(params);
      } catch (err) {
        reportLoaderError(`authorize failed for ${key}`, err);
        allowed = false;
      }
      if (!allowed) {
        sendJson(state.ws, {
          kind: "sub-error",
          id,
          key,
          params,
          reason: "unauthorized",
        });
        return;
      }
    }
    const pk = paramsKey(params);
    const { firstGlobal } = registerSubOnSocket(
      state,
      entry,
      pk,
      params,
      typeof m.tabId === "string" ? m.tabId : "",
      m.acks === true,
    );
    // Seeded derivation: answered (or refused) right here, synchronously after
    // the registration — so every change routed from now on reaches this tuple,
    // and none can land between the check and the copy.
    let derived = false;
    if (m.derive !== undefined) {
      const outcome =
        m.protocol !== PROTOCOL
          ? "protocol-skew"
          : firstGlobal
            ? deriveSub(entry, pk, params, m.derive)
            : "held";
      if (typeof outcome === "string") {
        recordDeriveFallback(key, outcome);
      } else {
        derived = true;
        derivedSubs.set(key, (derivedSubs.get(key) ?? 0) + 1);
        sendJson(state.ws, {
          kind: "sub-ack",
          id,
          key,
          params,
          version: entry.versions.get(pk) ?? 0,
          epoch: bootEpoch,
          derived: outcome,
        });
      }
    }
    if (firstGlobal && entry.onFirstSubscribe) {
      try {
        await entry.onFirstSubscribe(params);
      } catch (err) {
        reportLoaderError(`onFirstSubscribe failed for ${key}`, err);
      }
    }
    if (derived) return;

    // Version short-circuit: the client echoed the (epoch, version) its cached
    // value was produced under. If the epoch is THIS boot and the version equals
    // the current per-pk counter, nothing changed since that value shipped — for
    // a non-revalidate resource the version counter is its complete change
    // signal WITHIN a tracking span (every state change of a subscribed tuple
    // routes through flushNotifies, which bumps it), and a matching version is
    // always this span's: each span opens with a fresh one (`registerSubOnSocket`).
    // Answer `up-to-date` from memory: ZERO loader runs, ZERO read-admission
    // slots — the cure for the chronic full-set replay storms (each replayed
    // push-mode sub used to run the FULL loader behind the 6-slot gate; see
    // research/perfs/2026-07-11-compressor-thrash-subscription-replay-storm.md
    // Findings 2–3). Fully synchronous by construction. Restricted to:
    //   - same boot epoch — `entry.versions` is per-boot in-memory state, so a
    //     cross-boot version echo is incomparable (post-restart replays take the
    //     full path and re-baseline);
    //   - the same tracking span — never the subscriber that OPENS a span
    //     (`firstGlobal`: nobody tracked the tuple before it), and never an echo
    //     of a version minted before the span (the bump at the global 0→1). So
    //     a replay on a NEW socket, after the old one's close released the
    //     tuple, takes the full path like a post-restart one; a replay on the
    //     same socket registers before it reconciles and keeps its span;
    //   - non-`revalidate` resources — a revalidatable resource's freshness
    //     authority is its ETag signature (probed below), not the version
    //     counter (its truth may live outside the notify stream, e.g. git).
    // The HTTP path (`handleResourceHttp`) deliberately has NO version
    // short-circuit: the invalidate-mode refetch must return a body at an equal
    // version (the client's strict-`<` HTTP guard accepts it). That HTTP body
    // carries `epoch: bootEpoch` alongside the version, so the client can tell a
    // fresh same-boot body apart from a stale-boot cache — the epoch-aware guard
    // that fixes the cross-boot cache-poisoning drop (Fix B).
    const currentVersion = entry.versions.get(pk) ?? 0;
    if (
      !firstGlobal &&
      !entry.revalidate &&
      m.epoch === bootEpoch &&
      typeof m.version === "number" &&
      m.version === currentVersion
    ) {
      sendJson(state.ws, {
        kind: "up-to-date",
        id,
        key,
        params,
        version: currentVersion,
        epoch: bootEpoch,
      });
      recordSubShortCircuit(key);
      return;
    }

    await serveSub(state, entry, id, key, params, pk, clientEtag);
  }

  // The read/serve tail of a subscription: probe the conditional-revalidation
  // signature, run the gated full load, seed the keyed snapshot, and send the
  // sub-ack. Shared by `handleSub` and `handleSubBatch`'s full-path entries.
  // Callers have already registered the sub and settled `onFirstSubscribe`.
  async function serveSub(
    state: SocketState,
    entry: RegistryEntry,
    id: number | undefined,
    key: string,
    params: ResourceParams,
    pk: string,
    clientEtag: string | undefined,
  ): Promise<void> {
    // Report the CURRENT version without bumping: a sub-ack (or an `up-to-date`)
    // delivers existing state, it is not a state change. Bumping here made the
    // version climb on every (re)subscribe, which broke the missed-update
    // watchdog — the probe re-subscribes every sub, so the version always
    // appeared to advance even when nothing was missed. Mirrors
    // handleResourceHttp (also unbumped). The version advances only in
    // flushNotifies and when a tracking span opens (the global 0→1 in
    // `registerSubOnSocket`, before this runs) — so a first sub-ack reports at
    // least 1, which the client's -1 "nothing applied yet" baseline accepts.
    // Read up front because both the `up-to-date` short-circuit and the
    // loader-path sub-ack report it.
    const version = entry.versions.get(pk) ?? 0;

    // Conditional revalidation (ETag / 304 semantics): if this resource declares
    // a cheap signature, answer "is what you already have still current?" without
    // running the full loader when the client's last-known ETag matches. A backend
    // restart does not reload the page, so the client's cache still holds the last
    // value — on a match we send an `up-to-date` frame (the WS analogue of HTTP
    // 304) and the client keeps that cached value, adopting `version` so a later
    // real update isn't stale-dropped. This is the herd cure: a resubscribe for an
    // unchanged resource costs one cheap signature, not a full loader.
    //
    // THE INVARIANT: the ETag and the value must be produced by the SAME FLIGHT
    // over the same snapshot. An ETag may describe a snapshot OLDER than the value
    // it accompanies (costing one needless recompute on the next revalidation); it
    // must NEVER describe a newer one — that serves the stale value forever, since
    // the client's next revalidation matches the ETag, is answered
    // `up-to-date`/`304`, and an `invalidate`-mode push carries no value to heal it.
    //
    // Two mechanisms would break it, and both are closed here:
    //
    // 1. ORDERING. Computed AFTER the value, a change landing in between would ship
    //    a stale value stamped with an already-current ETag. So `computeEtag` runs
    //    FIRST, and any post-value change advances the ETag, forcing a real refetch.
    //    Still load-bearing — do not reorder.
    //
    // 2. COALESCING. Ordering alone is only sufficient if reading the value at time
    //    T yields the state at T. It does not when the flight COALESCES: two
    //    `handleSub`s that probed their own signatures either side of a change share
    //    one loader run, so the joiner holds the starter's older value while its own
    //    `freshEtag` names the newer state. So `freshEtag` is passed to `gatedRead`
    //    as a SEED and the flight hands back the etag it was actually seeded with
    //    (see `getResourceValue`). We stamp THAT — never `freshEtag` directly.
    //
    // `freshEtag` remains the right operand for the `up-to-date` short-circuit
    // below: that comparison is against THIS subscriber's `clientEtag` and asks
    // only "is your cached snapshot still current?", which no flight participates
    // in. `computeEtag` is fail-safe — undefined when the resource never opted in
    // OR the signature threw — so a broken signature degrades to the plain
    // full-loader path and never serves stale.
    const freshEtag = entry.revalidate
      ? await computeEtag(entry, params)
      : undefined;
    if (
      freshEtag !== undefined &&
      clientEtag != null &&
      freshEtag === clientEtag
    ) {
      sendJson(state.ws, {
        kind: "up-to-date",
        id,
        key,
        params,
        version,
        epoch: bootEpoch,
      });
      return;
    }

    // A BYTES value never rides a frame (it is an ArrayBuffer, and a frame is
    // JSON): its sub-ack carries no value, runs no loader, and stamps no etag
    // or watermark — both describe a value, and this frame ships none. It still
    // opens the tuple's ack bookkeeping (version, epoch); the client answers it
    // by reading the value over HTTP (`handleResourceHttp`'s octet-stream body).
    if (entry.bytes === true) {
      sendJson(state.ws, {
        kind: "sub-ack",
        id,
        key,
        params,
        version,
        epoch: bootEpoch,
      });
      return;
    }

    let value: unknown;
    let etag: string | undefined;
    let watermark: string | undefined;
    let baseVersion: number;
    try {
      // Origin = the subscription: establishes an entry context so the loader
      // span (and any gate waits it charges) is attributed to this `sub` request
      // instead of running with `parent: null`. Gated by the read-admission cap.
      ({ value, etag, watermark, baseVersion } = await gatedRead(
        entry,
        params,
        freshEtag,
      ));
    } catch (err) {
      // A gate gap: the tuple is registered, so evict it everywhere (which
      // tells this socket too) rather than leave every push re-failing.
      if (evictOnContractError(entry, params, err)) return;
      reportLoaderError(`loader failed for ${key}`, err);
      sendJson(
        state.ws,
        err instanceof ResourceRefusal
          ? {
              kind: "sub-error",
              id,
              key,
              params,
              reason: "refused",
              code: err.code,
              message: err.message,
            }
          : { kind: "sub-error", id, key, params, reason: "loader-failed" },
      );
      return;
    }
    // Yield ONCE before touching the snapshot or the wire. A push continuation
    // parked on the SAME coalesced flight attached after this read, so it
    // resumes one job later; it must still run first — it sends its update
    // frame synchronously (H5a: a push beats a racing parked sub-ack) and, for
    // keyed mode, performs the first diffKeyed (no snapshot yet → FULL update)
    // before this sub-ack's idempotent re-seed below (H5c). Before
    // gate-after-dedup the starter paid these hops implicitly in the
    // read-admission slot release chain; with the gate now inside the
    // single-flight, the yield is the explicit, pinned equivalent.
    await Promise.resolve();
    // Keyed entries: seed the per-pk snapshot from the full sub-ack value so the
    // next notify can diff against it. The sub-ack itself stays full-value.
    // Never over a snapshot a push advanced since this value's read STARTED
    // (the flight's `baseVersion`, not the version this subscriber observed —
    // a joiner observes a push that landed after the flight it joins began):
    // that push's base is at least as new as its change, while this read may
    // predate it. Regressing it would be harmless to a diff (an older base
    // ships extra rows, never fewer), but the router reads membership off it —
    // a value-role change to a host the regressed base lacks is dropped as a
    // non-member's, for good.
    if (entry.mode === "keyed") {
      const snapshots = (entry.snapshots ??= new Map());
      if (!snapshots.has(pk) || (entry.versions.get(pk) ?? 0) === baseVersion) {
        snapshots.set(pk, snapshotOf(entry, value));
        reseedOrderSigs(entry, params, value); // lifecycle mirrors the snapshot seed
        // The new base's floor is the flight's own watermark (C19): the value
        // this snapshot now holds reflects every commit below it.
        setBaseFloor(entry, pk, watermark);
      }
    }
    // Stamp the etag the FLIGHT carried, not `freshEtag`. Three cases:
    //   - we started the flight  → `etag === freshEtag` (the common path).
    //   - we joined a read flight → the starter's older seed. Safe direction.
    //   - we joined a flight started by a push-path caller (no seed) → undefined
    //     → OMIT the etag entirely. The client then stores no etag for this value
    //     and its next revalidation does a full load. Falling back to `freshEtag`
    //     here would stamp a signature strictly newer than the value we are
    //     shipping — precisely the skew this whole comment exists to prevent.
    // Absent for non-opted-in resources → the frame is byte-identical to before.
    // `epoch` (this boot's identity) rides every sub-ack so the client can echo
    // its version on the next replay and be short-circuited (see `handleSub`).
    // `watermark` is the flight-co-produced commit watermark (Rule B′): like the
    // etag, we stamp the FLIGHT's, never our own probe's — a joiner adopts the
    // starter's floor, so the watermark can never be newer than the value.
    // `up-to-date` frames deliberately carry none (they ship no value).
    sendJson(state.ws, {
      kind: "sub-ack",
      id,
      key,
      params,
      value,
      version,
      ...(etag !== undefined ? { etag } : {}),
      ...(watermark !== undefined ? { watermark } : {}),
      epoch: bootEpoch,
    });
  }

  // Whole-set replay for ONE tab (`op: "sub-batch"`). Registration is fully
  // synchronous and happens FIRST — before the `complete: true` reconciliation
  // below — so an identical replay never transits a sub 1→0→1: no lifecycle-hook
  // churn, no keyed-snapshot eviction. Then each entry either short-circuits
  // (same-boot epoch + matching version → collected into ONE `up-to-date-batch`
  // frame, zero loader runs) or serves the full path exactly like a single sub.
  // The whole function is synchronous; all async work (onFirstSubscribe, the
  // gated loads) is detached per entry, mirroring the `void handleSub(...)`
  // dispatch of single subs.
  function handleSubBatch(
    state: SocketState,
    m: ReceivedFrame<"sub-batch">,
  ): void {
    const tabId = typeof m.tabId === "string" ? m.tabId : "";
    const build = typeof m.build === "string" ? m.build : undefined;
    const entries = Array.isArray(m.entries) ? m.entries : [];

    // Pass 1 — synchronous registration of every entry.
    const prepared: Array<{
      entry: RegistryEntry;
      id?: number;
      key: string;
      params: ResourceParams;
      pk: string;
      etag?: string;
      version?: number;
      firstGlobal: boolean;
    }> = [];
    // Keys retained by the reconciliation, including entries routed through the
    // full per-sub path (authorize) whose registration is deferred — dropping
    // them here would 1→0→1 them before their own handleSub registers. A
    // refused entry (unknown key, params gate) is NOT retained: it never
    // registers, and a record the tab held for it before is released.
    const retained = new Set<string>();
    for (const e of entries) {
      if (!e.key) continue;
      const params = e.params ?? {};
      const pk = paramsKey(params);
      const entry = registry.get(e.key);
      if (!entry) {
        sendJson(state.ws, {
          kind: "sub-error",
          id: e.id,
          key: e.key,
          params,
          reason: "unknown-key",
          verdict: unknownKeyVerdict(build),
        });
        continue;
      }
      if (refuseSubParams(state.ws, entry, e.id, params, build)) continue;
      retained.add(`${e.key}\0${pk}`);
      if (entry.authorize) {
        // The authorization seam must run BEFORE any side effect (see
        // `handleSub`), so an authorized entry cannot be pre-registered here —
        // route it through the full per-sub path wholesale. (No shipped resource
        // declares `authorize` today.)
        void handleSub(state, {
          id: e.id,
          key: e.key,
          params,
          etag: e.etag,
          version: e.version,
          epoch: m.epoch,
          tabId,
          acks: e.acks,
          build,
        });
        continue;
      }
      const { firstGlobal } = registerSubOnSocket(
        state,
        entry,
        pk,
        params,
        tabId,
        e.acks === true,
      );
      prepared.push({
        entry,
        id: e.id,
        key: e.key,
        params,
        pk,
        etag: e.etag,
        version: e.version,
        firstGlobal,
      });
    }

    // `complete: true` reconciliation — this batch is the tab's WHOLE sub set,
    // so release every (key, pk) the tab previously held on this socket and did
    // not restate. Runs strictly AFTER registration (see the function comment).
    if (m.complete === true) {
      releaseTabSubs(state, tabId, retained);
    }

    // Pass 2 — synchronous short-circuit collection; everything else detaches
    // onto the full serve path.
    const upToDate: Array<{
      id?: number;
      key: string;
      params: ResourceParams;
      version: number;
    }> = [];
    for (const p of prepared) {
      const version = p.entry.versions.get(p.pk) ?? 0;
      if (
        !p.firstGlobal &&
        !p.entry.revalidate &&
        m.epoch === bootEpoch &&
        typeof p.version === "number" &&
        p.version === version
      ) {
        // Same short-circuit as `handleSub`, collected into one batch frame.
        // Never a 0→1 entry: its registration opened a tracking span, so it —
        // and its `onFirstSubscribe` — always takes the full path below.
        recordSubShortCircuit(p.key);
        upToDate.push({ id: p.id, key: p.key, params: p.params, version });
        continue;
      }
      void (async () => {
        // Mirror handleSub's ordering: settle the 0→1 hook before the read.
        if (p.firstGlobal && p.entry.onFirstSubscribe) {
          try {
            await p.entry.onFirstSubscribe(p.params);
          } catch (err) {
            reportLoaderError(`onFirstSubscribe failed for ${p.key}`, err);
          }
        }
        await serveSub(state, p.entry, p.id, p.key, p.params, p.pk, p.etag);
      })();
    }
    if (upToDate.length > 0) {
      sendJson(state.ws, {
        kind: "up-to-date-batch",
        epoch: bootEpoch,
        entries: upToDate,
      });
    }
  }

  function handleUnsub(state: SocketState, m: ReceivedFrame<"unsub">): void {
    const { key, params = {} } = m;
    if (!key) return;
    const inner = state.subs.get(key);
    if (!inner) return;
    const pk = paramsKey(params);
    const rec = inner.get(pk);
    if (!rec) return;
    // Remove only the FRAME's tab (legacy untagged → the `""` bucket); the
    // socket-level refcount releases only when the last holding tab is gone.
    const tabId = typeof m.tabId === "string" ? m.tabId : "";
    if (!rec.tabs.delete(tabId)) return;
    rec.ackTabs.delete(tabId);
    if (rec.tabs.size > 0) return;
    unregisterSubOnSocket(state, key, pk);
  }

  // Drop a socket's whole record for (key, pk) — every tab holding it — and
  // release the socket-level refcount. Returns whether the socket held it.
  function unregisterSubOnSocket(
    state: SocketState,
    key: string,
    pk: string,
  ): boolean {
    const inner = state.subs.get(key);
    const rec = inner?.get(pk);
    if (!inner || !rec) return false;
    inner.delete(pk);
    if (inner.size === 0) state.subs.delete(key);
    releaseSubRefcount(key, pk, rec.params);
    return true;
  }

  // Drop (key, params) from every socket that holds it, calling `onDropped`
  // for each (after the record is gone).
  function unregisterTupleEverywhere(
    key: string,
    params: ResourceParams,
    onDropped: (state: SocketState) => void,
  ): void {
    const pk = paramsKey(params);
    for (const state of sockets.values()) {
      if (unregisterSubOnSocket(state, key, pk)) onDropped(state);
    }
  }

  // `op: "sub-acks"` — flip one tab's ack request on a sub it already holds on
  // this socket, without re-subscribing (no sub-ack, no loader run). The
  // client sends it when its first optimistic observer of a tuple arrives or
  // its last one leaves while the sub stays; every later `sub` / `sub-batch`
  // entry restates the flag anyway. A frame for a sub this tab does not hold is
  // dropped: the client only sends it after the tuple's `sub`, and frames on a
  // socket are handled in order — only an `authorize`-deferred registration
  // (no shipped resource declares one) could still be pending.
  function handleSubAcks(
    state: SocketState,
    m: ReceivedFrame<"sub-acks">,
  ): void {
    const { key, params = {} } = m;
    if (!key) return;
    const rec = state.subs.get(key)?.get(paramsKey(params));
    const tabId = typeof m.tabId === "string" ? m.tabId : "";
    if (!rec?.tabs.has(tabId)) return;
    if (m.acks === true) rec.ackTabs.add(tabId);
    else rec.ackTabs.delete(tabId);
  }

  // Release every sub `tabId` holds on this socket, except (key,pk)s named in
  // `retain`. Backs both `op: "unsub-tab"` (no retain set — full departure) and
  // the `sub-batch complete: true` reconciliation. A pk still held by another
  // tab keeps the socket-level refcount; only a last-holder removal releases.
  function releaseTabSubs(
    state: SocketState,
    tabId: string,
    retain?: ReadonlySet<string>,
  ): void {
    for (const [key, inner] of state.subs) {
      for (const [pk, rec] of inner) {
        if (retain?.has(`${key}\0${pk}`)) continue;
        if (!rec.tabs.delete(tabId)) continue;
        rec.ackTabs.delete(tabId);
        if (rec.tabs.size > 0) continue;
        inner.delete(pk);
        releaseSubRefcount(key, pk, rec.params);
      }
      if (inner.size === 0) state.subs.delete(key);
    }
  }

  function releaseSubRefcount(
    key: string,
    pk: string,
    params: ResourceParams,
  ): void {
    const entry = registry.get(key);
    if (!entry) return;
    const prev = entry.subCounts.get(pk) ?? 0;
    if (prev <= 0) return;
    const next = prev - 1;
    if (next === 0) {
      entry.subCounts.delete(pk);
      // The tuple leaves the router's targets, and its memoized read-set with it.
      entry.tracked.delete(pk);
      entry.spans.delete(pk);
      entry.routing?.uses.delete(pk);
      // Bound keyed-snapshot memory to actively-observed pks. Re-subscribe
      // re-hydrates via a full sub-ack and rebuilds the snapshot.
      // M5 exception: a PERSISTED `scopedMembership` (unbounded-window alias)
      // entry recomputes on every change regardless of subscribers and
      // reconstructs its persisted value FROM the snapshot — so it must survive
      // N→0, or the next change would degrade to a needless FULL. Bounded to
      // opted-in persisted resources; bounded-membership entries (never
      // persisted) evict like any other keyed entry — the resubscribe opens a
      // new tracking span, so it takes the full path and re-seeds.
      if (!keepsIdleSnapshot(entry)) evictSnapshot(entry, pk);
      if (entry.onLastUnsubscribe) {
        try {
          entry.onLastUnsubscribe(params);
        } catch (err) {
          reportLoaderError(`onLastUnsubscribe failed for ${key}`, err);
        }
      }
    } else {
      entry.subCounts.set(pk, next);
    }
  }

  // --- HTTP handler ---

  /**
   * GET /api/resources/:key?foo=bar — returns {value, version}.
   *
   * Conditional GET: for a resource that declares `revalidate`, an incoming
   * `If-None-Match` header is compared against the cheap signature. A match
   * returns `304 Not Modified` (empty body) so the client keeps its cached
   * value; otherwise the value is returned with a fresh `ETag` response header
   * the client stores for its next request. This is the standard-transport path
   * that invalidate-mode revalidatable resources (e.g. edited-files) use, since
   * their value already arrives via this HTTP fallback rather than a WS push.
   * Behavior is byte-identical to before for a resource without `revalidate` or a
   * request without `If-None-Match`.
   */
  async function handleResourceHttp(
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> {
    const key = params.key;
    const build = req.headers.get(BUILD_GRAPH_HEADER) ?? undefined;
    if (!key) return httpError(404, { reason: "unknown-key" });
    if (key === "_debug") return handleResourcesDebug();
    const entry = registry.get(key);
    if (!entry) {
      return httpError(404, {
        reason: "unknown-key",
        verdict: unknownKeyVerdict(build),
      });
    }
    // Everything past the registry lookup — the revalidate signature and its 304
    // included — runs inside `wrapHttp` (server: an `http` entry span), so a
    // conditional GET is measured even when it never reaches a loader. Wrapped
    // only after the lookup, so the span label only ever names a registered key.
    const serve = () => serveResourceHttp(req, entry, build);
    return opts.wrapHttp ? opts.wrapHttp(key, serve) : serve();
  }

  // A failed read's JSON body (see `ResourceHttpErrorBody`): the client reads
  // the typed reason instead of a bare status. `no-store`, like every body here.
  function httpError(status: number, body: ResourceHttpErrorBody): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  }

  async function serveResourceHttp(
    req: Request,
    entry: RegistryEntry,
    build: string | undefined,
  ): Promise<Response> {
    const key = entry.key;
    const url = new URL(req.url);
    const rawParams: ResourceParams = {};
    for (const [k, v] of url.searchParams) rawParams[k] = v;
    // `?scopeId=` names the same tuple as no `scopeId` for an optional param.
    const resourceParams = canonicalTuple(entry, rawParams);

    // The params gate, exactly as on the WS path — a mismatch is a 409 with
    // its verdict, never a loader run (and never a 500 crash report).
    try {
      entry.validateParams(resourceParams);
    } catch (err) {
      if (!(err instanceof ResourceContractError)) {
        reportLoaderError(`validateParams failed for ${key}`, err);
        return httpError(500, { reason: "loader-failed" });
      }
      const verdict = rejectContract(key, resourceParams, err, build);
      return httpError(409, {
        reason: "contract-mismatch",
        verdict,
        detail: err.message,
      });
    }

    // Conditional revalidation: compute the signature ONCE, BEFORE the value, and
    // use it for the If-None-Match/304 short-circuit — a match means the caller's
    // cached snapshot is still current, so 304 with no body and no loader run.
    // `computeEtag` is fail-safe (undefined on opt-out or a throwing signature), so
    // a broken signature falls through to the full value below and stamps no ETag.
    const ifNoneMatch = req.headers.get("If-None-Match");
    const freshEtag = entry.revalidate
      ? await computeEtag(entry, resourceParams)
      : undefined;
    if (
      freshEtag !== undefined &&
      ifNoneMatch != null &&
      freshEtag === ifNoneMatch
    ) {
      // `no-store` even on the 304: the handler that emits the ETag (the header that
      // invites caching) owns forbidding the browser HTTP cache from storing the
      // revalidated body. Without it a restart-stable ETag lets the browser 304
      // onto a stale old-boot body it hands JS transparently — the cache-poisoning
      // wedge. See research/2026-07-15-global-live-state-http-cache-poisoning-class-fix.md.
      return new Response(null, {
        status: 304,
        headers: { "cache-control": "no-store" },
      });
    }

    // Read the CURRENT version BEFORE the load, exactly as `serveSub` does (read
    // its comment for the full argument). An HTTP body REPORTS an existing
    // version rather than minting one, so the version must describe a state no
    // newer than the value beside it: read after the load, a body could pair a
    // value the flight SELECTed at T0 with a version that pushes bumped since,
    // and the client's same-boot guard is strict `<` — an equal-or-greater
    // version is applied, pinning the stale value. Read before, a joined older
    // value can only ever report an older version, which the client drops and
    // RQ's `retry: 1` refetches. The version is unbumped either way (serving a
    // read is not a state change; only `flushNotifies` advances it).
    const pk = paramsKey(resourceParams);
    const version = entry.versions.get(pk) ?? 0;

    let value: unknown;
    let etag: string | undefined;
    let watermark: string | undefined;
    try {
      // Same-flight co-production, exactly as `handleSub` (read its comment for the
      // full argument): `freshEtag` SEEDS the flight; the flight hands back the etag
      // it was actually seeded with, which is the caller's own only if this call
      // started it. A joiner adopts the starter's older seed, or `undefined` when a
      // push-path caller started the flight.
      ({ value, etag, watermark } = await gatedRead(
        entry,
        resourceParams,
        freshEtag,
      ));
    } catch (err) {
      if (err instanceof ResourceContractError) {
        evictOnContractError(entry, resourceParams, err);
        return httpError(409, {
          reason: "contract-mismatch",
          verdict: "unknown",
          detail: err.message,
        });
      }
      reportLoaderError(`loader failed for ${key}`, err);
      if (err instanceof ResourceRefusal) {
        return httpError(422, {
          reason: "refused",
          code: err.code,
          detail: err.message,
        });
      }
      return httpError(500, { reason: "loader-failed" });
    }
    // `no-store` forbids the browser HTTP cache from storing this body — the
    // structural cure for the cache-poisoning wedge (a restart-stable ETag let the
    // browser 304-replay an old-boot body). See the 304 branch above and Fix A/E.
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "cache-control": "no-store",
    };
    // Stamp the etag the FLIGHT carried, never `freshEtag` — stamping a signature
    // newer than the body would let the next conditional GET 304 onto a stale
    // value forever. Undefined (opt-out, throwing signature, or a joined push-path
    // flight) → OMIT the header; the client then sends no If-None-Match next time
    // and gets a full body.
    if (etag !== undefined) headers["ETag"] = etag;
    // A BYTES value's body IS the value (`application/octet-stream`); the rest of
    // the envelope below — version, epoch, watermark, which the client's guard
    // needs exactly as for a JSON body — rides response headers instead.
    if (entry.bytes === true) {
      return new Response(value as ArrayBuffer, {
        headers: {
          ...headers,
          ...resourceBytesHeaders({
            version,
            epoch: bootEpoch,
            ...(watermark !== undefined ? { watermark } : {}),
          }),
        },
      });
    }
    // The body carries `epoch: bootEpoch` so the client can compare its cached
    // `entry.version` cross-boot: per-boot in-memory version counters are only
    // comparable within one boot, so an epoch-less strict-`<` guard dropped a
    // fresh body as "stale" against a stale-boot cache. See Fix B's guard matrix.
    // The body is a full value, so it may also carry the flight's commit watermark
    // (Rule B′) — same adoption discipline as the etag above.
    return new Response(
      JSON.stringify({
        value,
        version,
        epoch: bootEpoch,
        ...(watermark !== undefined ? { watermark } : {}),
      }),
      { headers },
    );
  }

  // A7 / D40: what an entry IS, as one closed set, checked in this order — a
  // deferred placeholder not bound yet (`unbound`: no loader, no routes), truth
  // outside Postgres (`external`: declared via `defineExternalResource`, so its
  // own `notify` reaches it), compiler-emitted routes (`routed`:
  // `routeTableChange`), and otherwise the legacy router (`legacy-full`: every
  // change to a relation base of its captured read-set recomputes each tracked
  // tuple FULL). The policy is not the whole delivery story: the legacy router
  // indexes every non-routed entry, so an external or unbound entry with a
  // captured read-set is ALSO reached FULL by its bases — `legacyReach` says so.
  function debugPolicyOf(entry: RegistryEntry): DebugPolicy {
    if (deferred.has(entry.key)) return "unbound";
    if (entry.externalSource) return "external";
    if (entry.routing) return "routed";
    return "legacy-full";
  }

  function handleResourcesDebug(): Response {
    rebuildDag();
    const now = Date.now();
    const ownerByKey = new Map<string, { pluginId?: string }>();
    for (const c of opts.debugOwners?.() ?? []) {
      ownerByKey.set(c.key, { pluginId: c.pluginId });
    }
    const out: Array<{
      key: string;
      mode: ResourceMode;
      pluginId?: string;
      subscribers: number;
      subCounts: Record<string, number>;
      versions: Record<string, number>;
      dependsOn: string[];
      downstream: string[];
      policy: DebugPolicy;
      readSet: string[];
      readSetBases: string[];
      legacyReach: string[];
      routes: Array<{
        id: string;
        table: string;
        map: HostMap["kind"];
        reason?: string;
      }> | null;
      derivedReads: string[];
      routeDrifted: string[];
      tuples: number;
      persisted: boolean;
      positionAgeMs: number | null;
      loaderStats?: { count: number; ratePerMin: number; maxMs: number };
      notifyStats: NotifyCounts;
      subShortCircuits: number;
      staleFlightSupersedes: number;
      derivedSubs: number;
      deriveFallbacks: Partial<Record<DeriveRefusal, number>>;
      subTabs: Record<string, number>;
      externalSource: boolean;
      freshness: ResourceFreshness | null;
      definition?: string | null;
      lastReplaceAt?: number | null;
      lastFloorAt?: number | null;
      l2PositionAt?: number | null;
    }> = [];
    for (const entry of registry.values()) {
      let subscribers = 0;
      // Per-tab breakdown: how many (socket, pk) subs each tab holds for this
      // resource. Legacy untagged subs show under `""`.
      const subTabs: Record<string, number> = {};
      for (const st of sockets.values()) {
        const inner = st.subs.get(entry.key);
        if (!inner) continue;
        subscribers += inner.size;
        for (const rec of inner.values()) {
          for (const tab of rec.tabs) subTabs[tab] = (subTabs[tab] ?? 0) + 1;
        }
      }
      const owner = ownerByKey.get(entry.key);
      const persisted = isPersisted(entry);
      const l2PositionAt = persistStats.get(entry.key)?.l2PositionAt;
      // The raw captured read-set (the view/table names the loader actually
      // read) and its relation bases — the base tables a change to which
      // reaches this entry through the legacy router (views and rollups
      // expanded). Unfiltered: a rollup shows in the raw set, its sources in
      // the bases. Identity on central (no views there).
      const rawReadSet = opts.readSet?.(entry.key) ?? [];
      const readSetBases = readSetBasesOf(entry.key);
      out.push({
        key: entry.key,
        mode: entry.mode,
        pluginId: owner?.pluginId,
        subscribers,
        // Authoritative per-pk server subscriber count (the diff fan-out factor):
        // how many tabs receive a delta for each params-tuple.
        subCounts: Object.fromEntries(entry.subCounts),
        versions: Object.fromEntries(entry.versions),
        dependsOn: entry.upstreamKeys,
        downstream: entry.downstream.map((d) => d.downstreamKey),
        // How a change reaches this entry (A7, D40) — see `debugPolicyOf`.
        policy: debugPolicyOf(entry),
        // Automatic table read-set captured at the DB chokepoint (server-only
        // hook; `[]` on central): the view / table / rollup names the loader
        // read, inverted into the read-set pane's captured index.
        readSet: rawReadSet,
        // The read-set expanded through the relation bases (base-table space).
        readSetBases,
        // The bases under which the legacy router indexes this entry — a write
        // to any of them recomputes it FULL (`applyLegacyFullChange`). Read off
        // the router's own predicate (`legacyRouted`), not off `policy`: an
        // EXTERNAL entry whose loader read the DB is reached here too, beside
        // its own `notify()`. `[]` for a routed entry (and on central).
        legacyReach: legacyRouted(entry) ? readSetBases : [],
        // A routed entry's routes (null = the legacy read-set path serves it):
        // every table it can be reached through, how its rows map, and — for a
        // `full` route — the declared reason, so a routed FULL is never silent.
        routes: entry.routing
          ? entry.routing.plan.routes.map((r) => ({
              id: r.id,
              table: r.table,
              map: r.map.kind,
              ...(r.map.kind === "full" ? { reason: r.map.reason } : {}),
            }))
          : null,
        // A routed entry's derived reads (the rollups its plan reads beside its
        // route tables, reached through their sources' routes) and the A8 drift
        // guard's own record: the captured tables no route names, each one a
        // table whose writes never reach the entry. Raw-table space, as the
        // guard judged them. `[]` for a legacy entry (and on central).
        derivedReads: entry.routing ? [...entry.routing.derived].sort() : [],
        routeDrifted: entry.routing ? [...entry.routing.drifted].sort() : [],
        // Tracked params-tuples (`entry.tracked`): the subscribed tuples a
        // change recomputes — a legacy-full entry's fan-out per change.
        tuples: entry.tracked.size,
        // L2-persisted, and how old its row's `position_at` is as last known
        // (null = not persisted, or no position known in this process).
        persisted,
        positionAgeMs:
          persisted && l2PositionAt !== undefined ? now - l2PositionAt : null,
        // Loader frequency over the profiling window (server-only hook; absent on
        // central). Surfaces a cheap-but-hot loader the slow-single-call view misses.
        loaderStats: opts.loaderStats?.(entry.key),
        // L4 self-verification: how many notifies came from hand-`notify()`, the
        // DB change-feed and an in-process change producer. A resource with
        // `hand > 0, feed === 0` is a read-set-gap candidate (the feed isn't
        // covering a table this resource reads).
        notifyStats: notifyStatsFor(entry.key),
        // Version short-circuits served for this key (a replayed sub answered
        // `up-to-date` from the in-memory version counter — zero loader runs,
        // zero read-admission slots). Live re-validation gauge for the
        // 2026-07-11 replay-storm fix.
        subShortCircuits: subShortCircuits.get(entry.key) ?? 0,
        // Stale-flight supersessions for this key (a push drain refused an
        // in-flight read older than the notify it was draining, and ran its
        // own). Non-zero means the pre-commit join that produced the 2026-08-08
        // revert is still reachable under load — and is now refused instead of
        // broadcast under a fresh version.
        staleFlightSupersedes: staleFlightSupersedes.get(entry.key) ?? 0,
        // Seeded derivations for this key (see `deriveSub`): subs answered
        // from rows the client held, and the ones that fell back to a load —
        // by reason.
        derivedSubs: derivedSubs.get(entry.key) ?? 0,
        deriveFallbacks: Object.fromEntries(
          deriveFallbacks.get(entry.key) ?? [],
        ),
        subTabs,
        // Declared classification: was this resource defined via
        // `defineExternalResource` (truth outside Postgres)? The
        // `no-db-backed-notify` check reads this to forbid a DB-reading loader on
        // an external resource.
        externalSource: entry.externalSource ?? false,
        // The declared freshness of an external value (`null`: none declared —
        // a db entry, or a resource not served through `network/live`).
        freshness: entry.freshness ?? null,
        // L2 bookkeeping, for a persisted key only: its definition (A18), when
        // this process last replaced / floor-wrote its row, and the row's
        // `position_at` as last known (epoch ms; null = never in this process).
        ...(persisted
          ? {
              definition: definitionOf(entry),
              lastReplaceAt: persistStats.get(entry.key)?.lastReplaceAt ?? null,
              lastFloorAt: persistStats.get(entry.key)?.lastFloorAt ?? null,
              l2PositionAt: l2PositionAt ?? null,
            }
          : {}),
      });
    }
    return new Response(
      JSON.stringify(
        { topoOrder: topoOrder.map((e) => e.key), resources: out },
        null,
        2,
      ),
      { headers: { "content-type": "application/json" } },
    );
  }

  // Load any registered resource by key through the same `timedLoad` path
  // `handleSub` uses (schema parse + profiler span). Throws on an unknown key.
  async function loadResourceByKey(
    key: string,
    params?: ResourceParams,
  ): Promise<unknown> {
    const entry = registry.get(key);
    if (!entry) throw new Error(`unknown resource key: ${key}`);
    // Bare value: this caller has no ETag to seed and none to report. Any read-path
    // subscriber that coalesces onto the flight it starts adopts its `undefined`
    // etag and stamps none (see `handleSub`).
    const { value } = await getResourceValue(
      entry,
      canonicalTuple(entry, params ?? {}),
    );
    return value;
  }

  // Run one full first-subscribe lifecycle and time it, then tear it down.
  // Mirrors `handleSub`'s 0→1 transition exactly: `onFirstSubscribe` first, then
  // the loader read through the SAME `getResourceValue` single-flight path — then
  // calls `onLastUnsubscribe` so the subcount-0 invariants/eviction are restored
  // and the next cold call recomputes. The two hooks fire exactly once each
  // (symmetric), so this leaves no dangling subscription/watcher. Generic — keyed
  // only by string; never names a concrete resource. Throws on an unknown key
  // (matches `loadResourceByKey`).
  async function measureSubscribeCycle(
    key: string,
    params?: ResourceParams,
  ): Promise<{ onFirstSubscribeMs: number; loaderMs: number }> {
    const entry = registry.get(key);
    if (!entry) throw new Error(`unknown resource key: ${key}`);
    const p = canonicalTuple(entry, params ?? {});
    const t0 = performance.now();
    await entry.onFirstSubscribe?.(p);
    const onFirstSubscribeMs = performance.now() - t0;
    const t1 = performance.now();
    await getResourceValue(entry, p);
    const loaderMs = performance.now() - t1;
    // Teardown: restore subcount-0 invariants (keyed snapshot eviction, watcher
    // release) so a later cold call recomputes. `onLastUnsubscribe` is typed sync
    // (void), but wrap in Promise.resolve to await defensively in case a hook
    // returns a thenable.
    await Promise.resolve(entry.onLastUnsubscribe?.(p));
    return { onFirstSubscribeMs, loaderMs };
  }

  // Re-emit a registered resource to its current subscribers WITHOUT a DB change.
  // Schedules a notify (tagged "synthetic" so the self-verification counters and
  // the read-set-gap warning are left untouched) so the loader re-runs against an
  // unchanged DB and the keyed diff comes back empty — a real no-op push. Sibling
  // to `loadResourceByKey`. With `params`, targets just that tuple; otherwise fans
  // out to every distinct currently-subscribed params tuple for the key. Returns
  // the number of param-tuples scheduled (0 = nobody listening, push unobservable).
  // Throws on an unknown key (fail loudly). Drives the live-state-churn emitter.
  function triggerResourcePush(key: string, params?: ResourceParams): number {
    const entry = registry.get(key);
    if (!entry) {
      throw new Error(`[resources] triggerResourcePush: unknown key "${key}"`);
    }
    const targets = params ? [params] : subscribedParamsFor(key);
    for (const p of targets) {
      scheduleNotify(entry, p, null, { source: "synthetic" });
    }
    return targets.length;
  }

  // Distinct currently-subscribed params tuples for a resource key, recovered
  // from every socket's `subs` map (the `ResourceParams` objects are stored there
  // at sub time). Deduped by pk across sockets.
  function subscribedParamsFor(key: string): ResourceParams[] {
    const byPk = new Map<string, ResourceParams>();
    for (const st of sockets.values()) {
      const inner = st.subs.get(key);
      if (!inner) continue;
      for (const [pk, rec] of inner) {
        if (!byPk.has(pk)) byPk.set(pk, rec.params);
      }
    }
    return [...byPk.values()];
  }

  // --- Scoped change routing (routed entries) ---

  // Route one base-table change to every ROUTED entry reading the table (see
  // `ResourceRuntime.routeTableChange` and `./routing`). Synchronous: each tuple's
  // pending is merged in this call, so the whole change rides one flush.
  // Defensive like `applyLegacyFullChange`: a failure is reported, never thrown at the
  // producer — and isolated per entry (per tuple inside `routeEntryChange`), so
  // one failing entry cannot take the change from the others.
  function routeTableChange(change: TableChange): void {
    for (const entry of routedByTable.get(change.table) ?? []) {
      try {
        routeEntryChange(entry, change);
      } catch (err) {
        reportLoaderError(
          `routeTableChange failed for ${entry.key} (table "${change.table}")`,
          err,
        );
      }
    }
  }

  // One routed entry, every tuple it must consider: its subscribed tuples
  // (`tracked` — never an O(sockets) scan), plus `{}` for a persisted entry,
  // which keeps its value current with nobody subscribed. A param'd window or
  // point set with no subscriber has nobody to keep current, so it gets nothing:
  // a fresh subscribe loads from scratch.
  function routedTargets(
    entry: RegistryEntry,
  ): [pk: string, params: ResourceParams][] {
    const targets = [...entry.tracked];
    if (isPersisted(entry) && !entry.tracked.has(EMPTY_PK)) {
      targets.push([EMPTY_PK, {}]);
    }
    return targets;
  }

  function routeEntryChange(entry: RegistryEntry, change: TableChange): void {
    const routing = entry.routing!;
    const routes = routing.byTable.get(change.table)!;
    for (const [pk, params] of routedTargets(entry)) {
      let outcome: ShapedRouting;
      try {
        const uses = usesFor(entry, routing, pk, params);
        outcome =
          uses === null
            ? { kind: "full" }
            : shapeForTuple(
                entry,
                pk,
                params,
                routeTuple(change, routes, uses),
              );
      } catch (err) {
        // A throwing `encode` / `idsOf`: fail open — this tuple recomputes FULL.
        reportLoaderError(
          `routing failed for ${entry.key} ${pk} (table "${change.table}")`,
          err,
        );
        outcome = { kind: "full" };
      }
      try {
        deliverRouted(entry, pk, params, outcome, change);
      } catch (err) {
        // Scheduling the outcome failed: fail open the same way. A second throw
        // escapes to `routeTableChange`, which reports it for this entry.
        reportLoaderError(
          `delivering a routed change failed for ${entry.key} ${pk} (table "${change.table}")`,
          err,
        );
        deliverRouted(entry, pk, params, { kind: "full" }, change);
      }
    }
  }

  // The tuple's memoized read-set (`RoutePlan.usesOf`), or null when it is
  // unusable — it threw, or it named a route this resource does not have (A9).
  // Either is reported once, and the tuple then recomputes FULL on every change
  // of its tables rather than guessing which occurrence it reads.
  function usesFor(
    entry: RegistryEntry,
    routing: RoutingRecord,
    pk: string,
    params: ResourceParams,
  ): ReadonlyMap<string, TupleUse> | null {
    const memo = routing.uses.get(pk);
    if (memo !== undefined || routing.uses.has(pk)) return memo ?? null;
    let uses: ReadonlyMap<string, TupleUse> | null = null;
    try {
      const answer = routing.plan.usesOf(params);
      const unknown = [...answer.keys()].find(
        (id) => !routing.routeIds.has(id),
      );
      // A match on a column its route did not declare: the change feed does
      // not carry it (the layout is derived from `Route.match`), so the key
      // filter could only ever read it as unknown.
      const undeclared =
        unknown === undefined
          ? [...answer].find(([id, use]) => {
              const declared = routing.matchOf.get(id) ?? [];
              return Object.keys(use.match ?? {}).some(
                (c) => !declared.includes(c),
              );
            })
          : undefined;
      if (undeclared !== undefined) {
        reportLoaderError(
          `usesOf matched on an undeclared column for ${entry.key}`,
          new Error(
            `route "${undeclared[0]}" of ${entry.key} matches on ${JSON.stringify(Object.keys(undeclared[1].match ?? {}))}, but declares match ${JSON.stringify(routing.matchOf.get(undeclared[0]) ?? [])} (tuple ${pk}) — that tuple recomputes FULL on every change of its tables`,
          ),
        );
      } else if (unknown === undefined) {
        uses = answer;
      } else {
        reportLoaderError(
          `usesOf named an unknown route for ${entry.key}`,
          new Error(
            `route id "${unknown}" is not one of ${entry.key}'s routes (tuple ${pk}) — that tuple recomputes FULL on every change of its tables`,
          ),
        );
      }
    } catch (err) {
      reportLoaderError(`usesOf failed for ${entry.key} (tuple ${pk})`, err);
    }
    routing.uses.set(pk, uses);
    return uses;
  }

  // Shape a scoped outcome by the tuple's membership kind, with ONE rule. A
  // point tuple first keeps only the ids in its own set, whatever the role.
  // Then, whatever the kind, a value-only host (one reached only through
  // value-role routes, or a `U` that left every `moves` column unchanged — it
  // cannot move membership) is kept only if the tuple holds it — but only while
  // the tuple is QUIESCENT: a snapshot, no pending, not draining. Otherwise a
  // drain that is admitting that host may have read the side table before this
  // write committed, and dropping the change would leave the host stale for
  // good; so it is delivered as membership instead (one extra refill, at
  // worst). The same guard turns its value-role reverse routes into membership
  // ones (resolved without the members bound — see `reverseWithin`). A point
  // snapshot is exactly the members its loader returned, so a requested id it
  // does not hold is not a member (a drain that fails evicts it rather than
  // leave it missing an entrant — see `drainMembershipFull`).
  function shapeForTuple(
    entry: RegistryEntry,
    pk: string,
    params: ResourceParams,
    outcome: TupleRouting,
  ): ShapedRouting {
    if (outcome.kind !== "scoped") return outcome;
    const membership = entry.membership!;
    let { affected, valueOnly, deleted } = outcome;
    if (membership.kind === "point") {
      const ids = new Set(membership.idsOf(params));
      const inSet = (set: ReadonlySet<string>) =>
        new Set([...set].filter((id) => ids.has(id)));
      affected = inSet(affected);
      valueOnly = inSet(valueOnly);
      deleted = inSet(deleted);
    }
    const snapshot = entry.snapshots?.get(pk);
    const quiescent =
      snapshot !== undefined &&
      !entry.pendingNotifies.has(pk) &&
      !entry.draining.has(pk);
    for (const id of valueOnly) {
      if (!quiescent || snapshot.has(id)) affected.add(id);
    }
    return {
      kind: "scoped",
      affected,
      deleted,
      unresolved: quiescent
        ? outcome.unresolved
        : outcome.unresolved.map((u) => ({
            ...u,
            role: "membership" as const,
          })),
    };
  }

  // Schedule the shaped outcome: FULL, a scoped pending (refill ids, identity
  // deletes, reverse routes to resolve), or — when nothing is left for this
  // tuple — at most the ack its writer is owed. A skip that owes no ack records
  // nothing, not even a feed intent: the change did not reach this tuple's value.
  function deliverRouted(
    entry: RegistryEntry,
    pk: string,
    params: ResourceParams,
    outcome: ShapedRouting,
    change: TableChange,
  ): void {
    const attribution = {
      source: change.source,
      ...(change.xid !== undefined ? { sourceTx: change.xid } : {}),
      ...(change.changedAt !== undefined
        ? { changedAt: change.changedAt }
        : {}),
    };
    if (outcome.kind === "full") {
      scheduleNotify(entry, params, null, attribution);
      return;
    }
    if (
      outcome.kind === "scoped" &&
      (outcome.affected.size > 0 ||
        outcome.deleted.size > 0 ||
        outcome.unresolved.length > 0)
    ) {
      scheduleNotify(entry, params, outcome.affected, {
        ...attribution,
        deleted: outcome.deleted,
        unresolved: outcome.unresolved,
      });
      return;
    }
    if (change.xid !== undefined && tupleWantsAcks(entry.key, params)) {
      scheduleAck(entry, pk, params, change.xid);
    }
  }

  // --- L4 DB change-feed routing ---

  // Route one DB change to the LEGACY (non-routed) readers of its table: invert
  // the L3 read-set through the relation bases, and FULL-recompute every
  // tracked tuple of each reader through the existing `scheduleNotify`, tagged
  // with the change's source. Defensive: an unread table is a silent no-op, and
  // it never throws (a lookup bug must not take down the LISTEN consumer).
  function applyLegacyFullChange(change: {
    table: string;
    source: ChangeSource;
    xid?: string;
    changedAt?: number;
  }): void {
    try {
      const affectedKeys = tableToResources().get(change.table);
      if (!affectedKeys || affectedKeys.length === 0) return;
      for (const key of affectedKeys) {
        const entry = registry.get(key);
        if (!entry) continue;
        const subscribed = subscribedParamsFor(key);
        // Fan out to every subscribed params tuple; with none, the `{}` tuple
        // (a param-less resource's only one — a persisted entry recomputes it
        // with no subscriber). A DB-backed membership entry is never legacy
        // (it is routed); an external window whose loader read a table is,
        // and its FULL pending re-reads the tuple (`drainMembershipFull`).
        const targets: ResourceParams[] =
          subscribed.length > 0 ? subscribed : [{}];
        for (const params of targets) {
          scheduleNotify(entry, params, null, {
            source: change.source,
            sourceTx: change.xid,
            changedAt: change.changedAt,
          });
        }
      }
    } catch (err) {
      // console.error fires (loud), plus the report hook.
      reportLoaderError(
        `applyLegacyFullChange failed for table "${change.table}"`,
        err,
      );
    }
  }

  // Force a FULL recompute of one resource by key (param-less → `{}`), through the
  // SAME `scheduleNotify(..., { source: "feed" })` path the feed router uses, so
  // the recompute is byte-identical to a feed-driven one. Used by the L2 boot init
  // for resources with no usable persisted read-set. No-op if the key is unknown.
  function recomputeResource(key: string): void {
    const entry = registry.get(key);
    if (entry) scheduleNotify(entry, {}, null, { source: "feed" });
  }

  function notifyStatsFor(key: string): NotifyCounts {
    const s = notifyStats.get(key);
    return {
      hand: s?.hand ?? 0,
      feed: s?.feed ?? 0,
      producer: s?.producer ?? 0,
    };
  }

  // Enumerate every table a routed entry's routes name. Read straight off the
  // registry — call it after `bindDeferredResources()`, so a deferred entry's
  // routes are in. A legacy entry is reached through its read-set and names none.
  function scopedResourceTables(): ScopedResourceTable[] {
    const out: ScopedResourceTable[] = [];
    for (const entry of registry.values()) {
      if (!entry.routing) continue;
      for (const route of entry.routing.plan.routes) {
        out.push({
          key: entry.key,
          table: route.table,
          via: `route "${route.id}"`,
        });
      }
    }
    return out;
  }

  // Every routed entry's routes, folded into one layout per table.
  function routedTableRequirements(): TableLayoutRequirement[] {
    const routes: Route[] = [];
    for (const entry of registry.values()) {
      if (entry.routing) routes.push(...entry.routing.plan.routes);
    }
    return tableLayoutRequirements(routes);
  }

  // The bounded-membership keys — the same set the L2 persist gate excludes via
  // `membershipBounded`. Reuses that exact predicate so the sweep and the gate
  // can never disagree about which keys are non-persistable.
  function boundedMembershipKeys(): string[] {
    const out: string[] = [];
    for (const entry of registry.values()) {
      if (membershipBounded(entry)) out.push(entry.key);
    }
    return out;
  }

  // The keys the persist gate admits — `isPersisted` itself, so the A6 boot
  // check and the drain can never disagree about which keys persist.
  function persistedKeys(): string[] {
    const out: string[] = [];
    for (const entry of registry.values()) {
      if (isPersisted(entry)) out.push(entry.key);
    }
    return out;
  }

  // Every registered unbounded-window (`scopedMembership` alias) key — the only
  // membership shape L2-persisted and reconstructed from its snapshot bytes.
  // Symmetric to boundedMembershipKeys; consumed by live-state-snapshot's boot seed.
  function unboundedWindowKeys(): string[] {
    const out: string[] = [];
    for (const entry of registry.values()) {
      if (isUnboundedWindow(entry)) out.push(entry.key);
    }
    return out;
  }

  // Every registered preloaded key — the registry's half of the server facade's
  // preload-declare boot assert (the other half is its `Resource.Declare` set).
  function preloadedKeys(): string[] {
    const out: string[] = [];
    for (const entry of registry.values()) {
      if (entry.preload !== undefined) out.push(entry.key);
    }
    return out;
  }

  // Seed the in-memory diff base for a persisted unbounded-window alias from its
  // durable L2 value at boot, so the first post-boot change is scoped (not a FULL
  // rebuild). No-op unless the entry is a registered unbounded-window alias with NO
  // snapshot yet for `paramsKey` (never clobber a fresher sub-ack seed). Mirrors the
  // FULL rebuild's seeding (snapshot + order sigs) via the same snapshotOf primitive.
  function seedPersistedSnapshot(
    key: string,
    paramsKey: string,
    value: unknown,
    base: PersistedBase,
  ): SeedOutcome {
    const entry = registry.get(key);
    if (!entry || !isUnboundedWindow(entry)) return { kind: "skipped" };
    if (entry.snapshots?.get(paramsKey) !== undefined) {
      return { kind: "skipped" };
    }
    // A30: a persisted value is only a diff base if it is a value this entry
    // could have produced. The raw (JSON) value is what is seeded, as before:
    // the parse only gates it.
    const check = checkPersistedPayload(entry, value);
    if (check.kind === "invalid") return check;
    (entry.snapshots ??= new Map()).set(paramsKey, snapshotOf(entry, value));
    // A params key is the tuple's canonical JSON (`paramsKey`).
    reseedOrderSigs(entry, JSON.parse(paramsKey) as ResourceParams, value);
    // ONLY on the branch that actually seeded: the row's position is the floor
    // of exactly this value (C19). A skipped seed leaves the fresher base's.
    setBaseFloor(entry, paramsKey, base.position);
    if (base.positionAt !== null) statsOf(key).l2PositionAt = base.positionAt;
    return { kind: "seeded" };
  }

  // A30's gate: its payload schema is the same check every loader output
  // passes (`timedLoad`).
  function checkPersistedPayload(
    entry: RegistryEntry,
    value: unknown,
  ): PersistedValueCheck {
    const parsed = entry.schema.safeParse(value);
    return parsed.success
      ? { kind: "valid" }
      : { kind: "invalid", error: parsed.error.message };
  }

  // A30 without the seed (see the interface).
  function validatePersistedValue(
    key: string,
    value: unknown,
  ): PersistedValueCheck {
    const entry = registry.get(key);
    if (!entry || !isUnboundedWindow(entry)) return { kind: "skipped" };
    return checkPersistedPayload(entry, value);
  }

  // The definition of every persisted key that has one (see the interface).
  function persistedDefinitions(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const entry of registry.values()) {
      const definition = definitionOf(entry);
      if (isPersisted(entry) && definition !== null) {
        out[entry.key] = definition;
      }
    }
    return out;
  }

  // The kept alias value at `{}` (see the interface). Only a persisted alias
  // keeps its snapshot current with nobody subscribed, so only it is served.
  function keptSnapshotValue(key: string): unknown[] | undefined {
    const entry = registry.get(key);
    if (!entry || !isUnboundedWindow(entry) || !isPersisted(entry)) {
      return undefined;
    }
    const snapshot = entry.snapshots?.get(EMPTY_PK);
    return snapshot ? valueOfSnapshot(entry, snapshot) : undefined;
  }

  function dropPendingPersists(): number {
    const dropped = armedFloors.size;
    for (const timer of armedFloors.values()) clearTimeout(timer);
    armedFloors.clear();
    return dropped;
  }

  return {
    defineResource,
    defineExternalResource,
    defineDeferredResource,
    bindDeferredResources,
    notificationsWsHandler,
    handleResourceHttp,
    withNotifyBatch,
    loadResourceByKey,
    measureSubscribeCycle,
    triggerResourcePush,
    applyLegacyFullChange,
    routeTableChange,
    recomputeResource,
    notifyStatsFor,
    scopedResourceTables,
    routedTableRequirements,
    boundedMembershipKeys,
    persistedKeys,
    unboundedWindowKeys,
    preloadedKeys,
    seedPersistedSnapshot,
    validatePersistedValue,
    persistedDefinitions,
    keptSnapshotValue,
    dropPendingPersists,
    readGateStats: () => readLoadGate.stats(),
  };
}
