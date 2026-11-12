import type { z } from "zod";
import { hashHex } from "@plugins/packages/plugins/string-hash/core";
import { createInflight } from "@plugins/packages/plugins/inflight/core";
import { canonicalParams } from "@plugins/network/plugins/live/plugins/canonical-params/core";
import { addressFrame } from "@plugins/primitives/plugins/networking/core";
import {
  createSemaphore,
  type SlotHolder,
} from "@plugins/packages/plugins/semaphore/core";
import {
  diffValue,
  type ValuePatchOp,
} from "@plugins/packages/plugins/value-patch/core";
import {
  BUILD_GRAPH_HEADER,
  DEV_BUILD,
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
} from "@plugins/network/plugins/live/plugins/resource-protocol/core";
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
import { ResourceGuardError } from "./guard-error";
import { createLingerLedger, type LingerEnd } from "./linger-ledger";
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
  type RoutePlanInput,
  type ReplayScope,
  type RouteVia,
  type TableChange,
  type TableLayoutRequirement,
  type HandoffDefinitionAnswer,
  type TupleRouting,
  type TupleUse,
  type TaggedRead,
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
// The runtime is acyclic and HOST-AGNOSTIC: besides `zod` it imports only the
// `packages/…` leaves (globally-allowed utility code, so no cycle — inflight for
// read-path single-flight coalescing, semaphore for the read-admission gate,
// string-hash for ETags and the default
// snapshot hash). No `bun`, no `node:*`, no `Bun.*`: the Bun server, central
// and a browser page all host it, each injecting what it does better through
// `ResourceRuntimeOptions` (the Bun hosts' `snapHash`). It declares its own
// structural socket (`RuntimeSocket`) and WsData/WsHandler rather than
// importing the facades' — importing from either facade would create a cycle.
// The returned `notificationsWsHandler` is structurally assignable to each
// facade's WsHandler (a Bun `ServerWebSocket` satisfies `RuntimeSocket`).

/**
 * The socket the runtime talks to: it `send`s text frames, closes it, and uses
 * it as a Map key (its identity). A Bun `ServerWebSocket` satisfies it
 * structurally; so does an in-memory pair end in a browser host.
 *
 * `send` answers whether the frame was ACCEPTED, in Bun's own convention: `0`
 * = not accepted (the frame is gone — Bun discards a frame sent while the
 * connection's buffer is past its `backpressureLimit`); anything else = sent
 * or queued. A frame the socket did not accept is never lost: the runtime
 * holds it, and every later frame behind it, in order, and sends them on
 * `drain` (see `deliver`).
 */
export interface RuntimeSocket {
  send(data: string): number;
  close(code?: number, reason?: string): void;
}

// Local, cycle-free copy of the WS types (see server-core/central-core types.ts).
export interface WsData {
  path: string;
}

export interface WsHandler {
  open(ws: RuntimeSocket): void;
  message(ws: RuntimeSocket, msg: string | { toString(): string }): void;
  close(ws: RuntimeSocket, code: number, reason: string): void;
  /** The socket's send buffer drained after a `send` it did not accept. */
  drain(ws: RuntimeSocket): void;
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
export type RoutedRecomputeOn<P extends ResourceParams = ResourceParams> =
  | {
      // biome-ignore lint/suspicious/noExplicitAny: upstream payload type is erased — only its key is read.
      resource: ExternalResource<any, P>;
      /** The one upstream tuple: its change recomputes EVERY subscribed tuple of the entry. */
      params: NoInfer<P>;
      paramsOf?: never;
    }
  | {
      // biome-ignore lint/suspicious/noExplicitAny: upstream payload type is erased — only its key is read.
      resource: ExternalResource<any, P>;
      /**
       * Per tuple: the upstream tuple THIS tuple compiles from (a scoped
       * column set's members, for the scope the tuple names), or `null` for
       * one that reads none. An upstream tuple's change recomputes exactly the
       * tracked tuples it names — pure, synchronous, cheap (it runs per
       * tracked tuple on each upstream change).
       */
      paramsOf: (params: ResourceParams) => NoInfer<P> | null;
      params?: never;
    };

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
  | {
      kind: "point";
      idsOf: (params: P) => readonly string[];
      /**
       * Whether concurrent cold reads of several tuples may be ONE load (see
       * `PointBatch`). Absent ⇒ every tuple loads alone.
       */
      batch?: PointBatch<P>;
    };

/**
 * A point set's batched cold read. A tuple's read-path load (sub-ack, HTTP)
 * that finds another tuple of the same `familyOf` still queued for its
 * read-admission slot rides that tuple's read instead of queueing its own: ONE
 * slot, ONE watermark and ONE loader run at the first member's params with
 * `ctx.affectedIds` = the union of the members' ids (at most `maxIds`), each
 * member then served the rows of its own ids. So the reconnect herd of a page
 * of per-row tuples (a chip per task, a row per report) costs one query per
 * resource instead of one per row, each holding a slot of six.
 *
 * The declaration is the loader's promise: for any two tuples of one family,
 * the loader at either's params reads exactly the rows `ctx.affectedIds`
 * names — the tuples differ in their ids alone (a compiled `:rows` read with a
 * static `where`). `maxIds` bounds the union to what the row-array schema
 * accepts.
 */
export interface PointBatch<P extends ResourceParams = ResourceParams> {
  familyOf: (params: P) => string;
  maxIds: number;
  /**
   * Whether the loader matches `id` under that spelling alone — the spelling
   * `keyOf` reads off the row it names (query-resource: the key column's
   * canonical text). For such an id, the batch's read returning no row PROVES
   * the row absent, and its member is answered from the batch. An id it
   * answers false for may match a row served under another spelling (an
   * upper-case uuid), which only that member's own read can tell: it is
   * re-read alone, in the batch's slot.
   */
  exactId: (id: string) => boolean;
}

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
  | {
      kind: "point";
      idsOf: (params: ResourceParams) => readonly string[];
      /** The batched cold read — see `PointBatch`. */
      batch?: PointBatch;
    };

/**
 * What one read-path load of a resource costs, for read admission — see
 * `ResourceDefinition.readCost`.
 */
export type ReadCost = "io" | "memory";

/** A resource's declared freshness — see `ResourceDefinition.freshness`. */
export interface ResourceFreshness {
  kind: "notified" | "immutable" | "fixed" | "snapshot";
  /** Why the value is never told of a change (absent for `"notified"`). */
  reason?: string;
}

/**
 * A value's declared shape — see `ResourceDefinition.shape`: every list its
 * payload holds, capped (`max`) or loaded whole (`reason`), and the paths of
 * the bare ones; `paged` when the payload is key-range pages (the lists are
 * then its item's, under `[]`). `network/live`'s `LiveValueShape`, matched
 * structurally (this module imports no declaration layer).
 */
export interface ResourceListShape {
  readonly paged: boolean;
  readonly bounds: readonly (
    | { readonly path: string; readonly max: number }
    | { readonly path: string; readonly reason: string }
  )[];
  readonly bare: readonly string[];
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
    run?: LoadRun,
  ) => Promise<T> | T;
  /**
   * Zod schema for the payload. Required. The server parses every loader output
   * against it at load time (single chokepoint in `timedLoad`) before any
   * broadcast — a payload that violates its schema fails loudly instead of
   * shipping. The descriptor exposed to clients carries the same schema so the
   * browser re-parses before the value lands in the TanStack cache. See
   * research/2026-06-08-global-mandatory-resource-schema-server-validation.md.
   */
  schema: z.ZodType<T>;
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
   * them. Present ⇒ the entry is ROUTED: `routeTableChange` serves it. Only on a membership entry (`membership` / `scopedMembership`)
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
   * one declaring `routes` (served by `routeTableChange`): a change to a table a tuple reads recomputes that tuple,
   * and a change to any other table reaches nothing. Exclusive with
   * `routes`; refused on a keyed entry (a throw in `createResource`) — except
   * an EXTERNAL keyed window or point set (D31, `ExternalKeyedPolicy.reach`),
   * whose every change is a FULL re-read of the tuple anyway. Allowed
   * on a NON-keyed EXTERNAL entry (D1): an external value whose loader reads
   * Postgres declares those reads, a table write FULL-recomputes its tuples,
   * and its own `notify()` merges into the same pending. Unlike `routes` it
   * may sit beside `dependsOn`: every reach route is `full`, so a cascade's
   * FULL has no scoped refill to override — both land in the tuple's one
   * pending (a served value's `recomputeOn`). Compiler-minted
   * (`mintReachPlan`), like `routes`.
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
   * cascade from one would serve the entry twice (T15). Both throw in
   * `createResource`.
   */
  recomputeOn?: ReadonlyArray<RoutedRecomputeOn>;
  /**
   * Leading-edge throttle (ms) for this resource's flushes: drains are at
   * least `debounceMs` apart. A `notify()` (or cascaded `mergePending`) into an
   * entry that has not drained within the last window drains on the next flush
   * (the leading edge — an isolated change is never held); one landing inside
   * the window arms a per-entry timer for the window's REMAINDER (never re-armed
   * by later notifies, starvation-free), so a continuously-ticking source still
   * drains once per `debounceMs`. The merge into `pendingNotifies` is
   * unchanged, so all coalescing keeps working — the throttle only decides
   * *when* the accumulated pending map drains. Only the throttle releases the
   * entry's pending — a flush another resource triggers inside the window
   * leaves it held (no piggyback; on a busy server one would drain it on every
   * change), and a cascade into the entry is throttled like a notify. So the
   * entry recomputes at most once per `debounceMs`, whatever else flushes.
   * See research/2026-10-22-global-live-throttle-holds.md (the leading edge
   * came after: a trailing-only window held every isolated change a full window,
   * e.g. `app-usage.summary` delivering each once-a-minute flush 2 s late).
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
   * A change reached a TRACKED tuple through a follow route (`Route.via` — a
   * followed collection's rows moved), whatever the entry's mode: called
   * synchronously from the router, outside any flight, wrapped in a `bg`
   * origin (`wrapOrigin`). network/live's `serveValue` re-reads the tuple's
   * followed rows here and re-points its `whileFollowing` start when they
   * moved — so a watch over a followed fact (a worktree path, a session chain)
   * follows it. Answers whether it re-pointed (`_debug`'s `followRepoints`
   * counts `"repointed"`); a rejection is reported. Requires follow routes in
   * the entry's reach plan (a throw at registration / bind otherwise — it
   * would never fire). Handed the tuple's held follows (`HeldFollows`): the
   * reached follow's read is already dropped, so it reads fresh — and the
   * load the same change schedules reads what it read.
   */
  onFollowReached?: (
    params: P,
    follows?: HeldFollows,
  ) => Promise<FollowReached>;
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
   * spawn git/fs). Absent ⇒ today's full-loader behavior, unchanged. A
   * follower's is handed the tracked tuple's held follows (`HeldFollows`).
   */
  revalidate?: (params: P, follows?: HeldFollows) => Promise<string>;
  /**
   * What one read-path load (and `revalidate` probe) costs, for read
   * admission (`READ_LOAD_CONCURRENCY`). `"io"` (the default): it may spawn,
   * read files or query, so it takes a read-admission slot. `"memory"`: it
   * answers from memory this process holds — a constant, or a memo whose
   * build every reader shares — so there is nothing per read for the gate to
   * bound: it takes no slot and never queues behind loads that do I/O (main,
   * 2026-11-06: `icons.sprite` waited 2.4 s for a slot behind git loaders).
   * Checked at runtime: a `"memory"` read slower than
   * `MEMORY_READ_BUDGET_MS` is reported, once per key — the declaration is
   * wrong, or its memo was cold.
   */
  readCost?: ReadCost;
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
   * The declared shape of the payload's lists (`network/live`'s `liveValue`
   * walks its schema at declaration). A label only, like `freshness`: the
   * `_debug` payload shows it per key; the parse is what enforces a cap.
   */
  shape?: ResourceListShape;
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
   * (`network/live/canonical-params`).
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
  /**
   * A PATCHED value, declared once on the shared client descriptor (a
   * `liveValue`'s `patches: true`): a drain that has the value every holder
   * holds (`RegistryEntry.held`) ships what changed as a `patch` frame
   * (`packages/value-patch`) instead of an `update`, and a sub-ack while that
   * base stands is answered FROM it — so one version names one value for
   * every holder, and every holder can apply the next patch. Mode `push`
   * only, never beside `revalidate` or a persisted entry (throws). Absent ⇒
   * every change ships the whole value.
   */
  patches?: true;
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
      reach?: never;
    }
  | {
      routes: RoutePlan<P>;
      scopedMembership: AliasMembership<P> & {
        orderSignatureOf: (row: unknown, params: P) => string;
      };
      recomputeOn?: ReadonlyArray<RoutedRecomputeOn>;
      membership?: never;
      dependsOn?: never;
      reach?: never;
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
 * The id set of an EXTERNAL keyed point tuple — `KeyedMembership`'s point arm:
 * `idsOf(params)` decodes the ids the tuple names (pure, synchronous — the
 * caller's point codec, e.g. network/live's `:rows` decode). The loader at
 * the tuple reads exactly those rows (an id it cannot find is simply absent).
 * Every change is the resource's own `notify(params)`, a FULL re-read of the
 * tuple diffed by key, so nothing else is declared.
 */
export interface ExternalPointMembership<
  P extends ResourceParams = ResourceParams,
> {
  kind: "point";
  idsOf: (params: P) => readonly string[];
}

/**
 * An EXTERNAL resource's keyed window arm (D31: an external resource is never
 * ROUTED — its truth is outside Postgres — but it may be keyed): a bounded
 * window whose change arrives as the resource's own `notify(params)`, which
 * re-reads the tuple whole and diffs it by key against its snapshot
 * (`drainMembershipFull`) — keyed `delta` frames, seeded derivation
 * (`familyOf`) and one client cache path, exactly as a routed window has them.
 * No `routes` (no scoped route refills it — it may take a full-only `reach`
 * plan for the Postgres reads its loader also makes) and no cascade OUT of it
 * (D32: a membership entry has no downstream); it may itself follow external
 * upstreams (`dependsOn`), each change a FULL re-read. Its point twin is
 * `ExternalPointPolicy`; either is an `ExternalKeyedPolicy`.
 */
export interface ExternalWindowPolicy<
  P extends ResourceParams = ResourceParams,
> {
  membership: ExternalWindowMembership<P>;
  /**
   * The Postgres reads the loader makes beside its own truth, as a
   * compiler-minted reach plan (`mintReachPlan` — query-resource's
   * `compiledValueReach` / `offFeedTablesReach`), held to the same rules as a
   * non-keyed entry's (`ResourceDefinition.reach`) except one: every route is
   * `full` (asserted), so a change a tuple's uses let through is a FULL
   * re-read of that tuple (`drainMembershipFull`, merged with its notifies) —
   * never a scoped refill, which only a routed membership has. So a route's
   * `columns` gate and its per-tuple `match` narrow WHICH tuples re-read (a
   * paged value's lookup of its question's row: an UPDATE of a column it
   * does not read reaches no page, an INSERT of another row reaches only
   * that row's questions). Its `unfed` tables (read outside the feed — a
   * table served off it, network/live's `serveCollection` with `changes`)
   * are accepted by the drift guard and listed by `unfedResourceTables()`;
   * its `relations` (views read whole) are indexed under their bases. Omit
   * when the loader reads no Postgres table.
   */
  reach?: ReachPlan<P>;
  routes?: never;
  scopedMembership?: never;
  recomputeOn?: never;
}

/**
 * An EXTERNAL resource's keyed point arm: `ExternalWindowPolicy`'s twin over
 * an id set (`ExternalPointMembership`) — the same FULL re-read on `notify`,
 * the same keyed deltas, never routed, nothing cascading out. It never
 * derives (seeded derivation is a window's).
 */
export interface ExternalPointPolicy<
  P extends ResourceParams = ResourceParams,
> {
  membership: ExternalPointMembership<P>;
  /** The Postgres reads its loader makes — see `ExternalWindowPolicy.reach`. */
  reach?: ReachPlan<P>;
  routes?: never;
  scopedMembership?: never;
  recomputeOn?: never;
}

/** An EXTERNAL keyed resource's scope: a bounded window or a point set. */
export type ExternalKeyedPolicy<P extends ResourceParams = ResourceParams> =
  ExternalWindowPolicy<P> | ExternalPointPolicy<P>;

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
  schema: z.ZodType<T>;
  keyed?: { keyOf: (row: unknown) => string };
  /**
   * Preload marker, declared once on the shared client descriptor. Threaded
   * through onto the returned `Resource` so `Resource.Declare` derives its payload
   * from it instead of restating it in server-side opts. See the descriptor in
   * `@plugins/network/plugins/live/plugins/live-state/core`.
   */
  preload?: "boot" | "boot-and-keep";
  /** Optional param names — see `ResourceDefinition.optionalParams`. */
  optionalParams?: readonly string[];
  /** Declared refusal codes — see `ResourceDefinition.refusals`. */
  refusals?: readonly string[];
  /** A bytes value — see `ResourceDefinition.bytes`. */
  bytes?: true;
  /** A patched value — see `ResourceDefinition.patches`. */
  patches?: true;
  /** The declared list shape, a `_debug` label — see `ResourceDefinition.shape`. */
  shape?: ResourceListShape;
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
  /** A follow route reached a tracked tuple — see `ResourceDefinition.onFollowReached`. */
  onFollowReached?: ResourceDefinition<T, P>["onFollowReached"];
  /** Conditional-revalidation ETag signature — see `ResourceDefinition.revalidate`. */
  revalidate?: ResourceDefinition<T, P>["revalidate"];
  /** What one read costs, for read admission — see `ResourceDefinition.readCost`. */
  readCost?: ReadCost;
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
 * which routes the entry by the tables each tuple reads — beside `dependsOn`
 * if it likes: every reach route is `full`, so there is no scoped refill for a
 * cascade to override.
 */
export type ServerResourceOptions<
  T,
  P extends ResourceParams = ResourceParams,
> = ServerResourceOptionsBase<T, P> & {
  mode: "push" | "invalidate";
  reach?: ReachPlan<P>;
};

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
      `${where}: "${found.join('", "')}" on key "${key}" — the legacy scope policy is gone: a keyed entry routes through a compiler-minted "routes" plan and a membership, and a non-keyed one through a "reach" plan`,
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
    ...(contract.patches === true ? { patches: true as const } : {}),
    ...(contract.shape !== undefined ? { shape: contract.shape } : {}),
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
    ...(opts.onFollowReached !== undefined
      ? { onFollowReached: opts.onFollowReached }
      : {}),
    revalidate: opts.revalidate,
    ...(opts.readCost !== undefined ? { readCost: opts.readCost } : {}),
    authorize: opts.authorize,
    ...(opts.freshness !== undefined ? { freshness: opts.freshness } : {}),
    validateParams: opts.validateParams ?? contract.validateParams,
  };
}

export interface Resource<T, P extends ResourceParams = ResourceParams> {
  key: string;
  mode: ResourceMode;
  schema: z.ZodType<T>;
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
   *
   * `change.changedAt` (wall-clock epoch ms): when the external source itself
   * changed, if the notifier knows — a file's write, heard later by a watch.
   * It becomes the pending's `changedAt` (the frame's `timing`), so the tab's
   * update latency starts there. Absent: the call is the change.
   * `change.heardAt`: when the host's watch heard that write (see
   * `PendingNotify.heardAt`) — rides beside `changedAt`, never alone.
   */
  notify(params?: P, change?: { changedAt?: number; heardAt?: number }): void;
}

/**
 * What a deferred EXTERNAL value fixes at definition (see
 * `ResourceRuntime.defineDeferredResource`): its delivery mode and its
 * declared freshness — both read before its bind.
 */
export interface DeferredExternal {
  mode: "push" | "invalidate";
  freshness?: ResourceFreshness;
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
  routedRecompute?:
    | { upstreamPk: string; paramsOf?: never }
    | {
        paramsOf: (params: ResourceParams) => string | null;
        upstreamPk?: never;
      };
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
   * (the non-membership drain is FULL-only).
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
   * How long this pending sat waiting out its entry's declared throttle
   * (`debounceMs`): from `enqueuedAt` to the instant the window released it
   * (`debounceReleasedAt`), stamped by the drain. 0 / absent for an entry
   * with no throttle and for a change that landed on the leading edge. Rides
   * `timing.holdMs`, so a tab can tell a declared hold from slowness.
   */
  holdMs?: number;
  /**
   * How long this pending, once released (`enqueuedAt + holdMs`), waited for
   * a drain to take it: an earlier pass's barrier entries, an earlier depth
   * level of this pass, or (a leaf) its own previous lane still in flight.
   * Stamped by `drainEntry` when it takes the pending. Time spent waiting on
   * other drains, not this one — `onDelivered` reports it apart
   * (`ResourceDelivery.queueMs`) so a delivery is judged on its own drain only.
   */
  queueMs?: number;
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
   * its oldest change. It rides every value frame's `timing` (`frameTiming`,
   * beside the send time and `deliverMs`) so the TAB can measure change →
   * applied on a clock the serving thread does not own: `enqueuedAt`
   * above is stamped when this thread finally reads the NOTIFY, so a stalled
   * thread hides its own delay from `onDelivered`'s `latencyMs` (which reports
   * it beside, as `changedAt`). Observability only — no runtime decision reads
   * it. Comparing it to the tab's `Date.now()` assumes browser, backend and
   * Postgres share one machine clock (one instance per user). Absent for
   * synthetic and ack-only pendings and for catch-up replay.
   */
  changedAt?: number;
  /**
   * When the host's file watch heard the change `changedAt` names (wall-clock
   * epoch ms) — set only with it, and replaced with it whenever a merge lowers
   * `changedAt`, so the pair always names one change. Rides the frame's
   * `timing`: the tab splits `changedAt → heardAt` out as `watch-delivery`,
   * the server's to judge (`bg watch-delivery:<backend>`). Absent for any
   * change no watch heard (a DB change, a hand notify).
   */
  heardAt?: number;
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
 * D8 — the value every holder of a tuple holds (`RegistryEntry.held`).
 * `raw` only on a `revalidate` entry: the loader's own return, compared by
 * identity as a fast path (a signed memo hands its cached object back).
 */
interface HeldValue {
  version: number;
  value: unknown;
  raw?: unknown;
}

/**
 * A drain's D8 comparison against the held value at `base`: `diffValue`'s
 * ops (`null` = the root itself changed), shipped by a patched entry.
 */
interface ValuePatch {
  base: number;
  ops: ValuePatchOp[] | null;
}

/**
 * What one read flight co-produces (see `getResourceValue`): the value, the
 * etag it was seeded with, its commit watermark, the ackTx it may stamp, and the
 * tuple's version when its read started.
 */
interface FlightValue {
  value: unknown;
  /**
   * The loader's own return, before the schema parse (which copies): what
   * D8's memo fast path compares by identity (`HeldValue.raw`). Never sent.
   */
  raw: unknown;
  etag: string | undefined;
  watermark: string | undefined;
  ackTx: readonly string[] | undefined;
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
 * and, for a non-keyed entry, `ResourceDefinition.reach`) — or, for a guarded
 * external that declared no reads, the drift guard's own record (D5: `plan`
 * routes nothing, and only `drifted` is ever filled).
 */
interface RoutingRecord {
  /** The validated plan (minted — checked at registration; `NO_ROUTES` for a drift-only record). */
  plan: RoutePlanInput<ResourceParams>;
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
   * The tables a reach plan reads outside the change feed by declaration
   * (`ReachPlan.unfed`): no change source, so no route — the drift guard
   * accepts them in a capture, and change-feed's boot check refuses one that
   * does have a change source.
   */
  unfed: ReadonlySet<string>;
  /**
   * The relations (views, rollups) a reach plan reads whole
   * (`ReachPlan.relations`), relation → reason. No route names one: each is
   * expanded to its relation bases and indexed for the router by
   * `indexRelationReads` (once the bases are known), and the drift guard
   * accepts the relation's own name in a capture.
   */
  relations: ReadonlyMap<string, string>;
  /**
   * The relations an external entry's own notify covers
   * (`ReachPlan.notified`), relation → reason: never routed, never indexed
   * under their bases — the drift guard accepts them in a capture.
   */
  notified: ReadonlyMap<string, string>;
  /**
   * The route tables a capture covers only through tagged reads
   * (`ReachPlan.taggedReads`), table → the tags that cover it: a read of one
   * carrying no tag, or another, is drift (`readCovered`).
   */
  tagged: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * The tables a reach plan reads through follows (`Route.via`), table → every
   * follow reading it (two follows may read one table): routed by the copied
   * collection routes, and read ONLY through the collections' own reads, in
   * their own loader spans — so the entry's own capture never covers one
   * (`readCovered`: a read of it by hand is drift).
   */
  via: ReadonlyMap<string, readonly RouteVia[]>;
  /**
   * A8: the tables a loader run read that no route names, each reported once
   * and — in a running server — indexed for the router as a FULL read of the
   * entry (see `checkRouteDrift`).
   */
  drifted: Set<string>;
  /**
   * The bases this entry is indexed under in `routedByTable` for each reason
   * no route gives: a relation read's (`indexEntryRelations`, dropped and
   * re-taken whenever the relation bases are reset) and a drifted relation's
   * (`failOpenDrift`, kept for the process). A base in both stays indexed
   * when the relation reads are reset.
   */
  relationBases: Set<string>;
  driftBases: Set<string>;
  /**
   * D7: the relations a persisted `tables_read` named that the declaration
   * does not cover (`seedRouteDrift`) — failed open on their bases like a
   * drifted read, but NOT counted as covered: the row may predate a
   * declaration change, so only a load that reads one again reports it (and
   * moves it to `drifted`); a load that does not read it drops it and
   * un-indexes its bases (`dropUnreadSeeds`).
   */
  seededDrift: Set<string>;
  /**
   * Memoized `usesOf` per tracked pk. `null` = the answer was unusable (it threw
   * or named an unknown route id) — reported once, and that tuple recomputes FULL
   * on every change of its tables. Evicted with the tuple (N→0).
   */
  uses: Map<string, ReadonlyMap<string, TupleUse> | null>;
  /**
   * The routes of DEPENDENT follows (`RouteVia.loaded`): a tuple's match on
   * them is what its last completed load noted (`loaded`). Empty for every
   * other plan — then `loaded` / `loading` stay empty too.
   */
  loadedRoutes: ReadonlySet<string>;
  /**
   * Per pk, what the newest-STARTED completed load noted
   * (`LoadRun.noteLoaded`) and that load's start sequence — so a slower,
   * older load never overwrites a newer one's. Evicted with the tuple (N→0).
   */
  loaded: Map<string, { seq: number; state: unknown }>;
  /** Per pk, the loads in flight: while any is, loaded routes skip their match (see `usesFor`). */
  loading: Map<string, number>;
  /**
   * Per TRACKED pk, its held followed rows (`HeldFollows`) — only a plan with
   * follow routes holds any. A change reaching the tuple through a follow drops
   * that follow's read (`reachFollows`); evicted with the tuple (N→0).
   */
  followHeld: Map<string, FollowHeldState>;
}

/**
 * What a loader may tell the runtime about its run, and what the runtime holds
 * for it — handed to every load of an entry with follow routes (`Route.via`).
 */
export interface LoadRun {
  /**
   * What this load read that decides the tuple's match on its loaded routes
   * (`RouteVia.loaded`): handed back to `usesOf(params, loaded)` once the
   * load completes, unless a newer-started load already completed. A no-op
   * on an entry with no loaded route.
   */
  noteLoaded(state: unknown): void;
  /** The tuple's held followed rows (`HeldFollows`) — absent for a tuple nobody tracks. */
  readonly follows?: HeldFollows;
}

/**
 * A TRACKED follower tuple's followed rows, as the runtime holds them: each
 * follow's last read (by its name and the tuple it read — a dependent follow's
 * tuple may move), kept until a change reaches the follower tuple THROUGH that
 * follow's routes (`Route.via` — the very routes that decide whether a write
 * moves those rows). So a recompute the follow did not cause — the value's own
 * notify, a change to another table — reads the rows it already has: O(1), no
 * nested load. A change that reaches the follow drops its rows (and any read in
 * flight from before it), so the next read is fresh. Held only while the tuple
 * is tracked (its routing is what invalidates them), and dropped with it (N→0).
 */
export interface HeldFollows {
  /**
   * The rows of follow `name` read at `tuple` (its canonical JSON): the held
   * read when it is still current, else `fresh()` — joined by every later read
   * of the same tuple until a change reaches the follow. A failed read is held
   * by no one.
   */
  read(
    name: string,
    tuple: string,
    fresh: () => Promise<readonly unknown[]>,
  ): Promise<readonly unknown[]>;
}

/** One tracked tuple's held follows (`HeldFollows`): per follow, its current read. */
interface FollowHeldState {
  /** Per follow name: the tuple it read and the read (resolved or in flight). */
  readonly reads: Map<
    string,
    { tuple: string; rows: Promise<readonly unknown[]> }
  >;
}

/** A drift-only routing record's plan (see `RoutingRecord`): it routes nothing. */
const NO_ROUTES: RoutePlanInput<ResourceParams> = {
  routes: [],
  usesOf: () => new Map(),
};

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
   * A patched value — see `ResourceDefinition.patches`: its drains ship
   * the D8 comparison's ops against `held` as a `patch` frame, and while
   * `held` stands a sub-ack is answered FROM it.
   */
  patches?: true;
  /**
   * True when declared via `defineExternalResource` — the resource's truth lives
   * outside Postgres, so a hand-`notify()` is legitimate. The backstop check
   * (`no-db-backed-notify`) fails if such a resource's loader reads the DB.
   * Surfaced in the `_debug` payload.
   */
  externalSource?: boolean;
  /** Declared freshness (`ResourceDefinition.freshness`) — surfaced in `_debug`. */
  freshness?: ResourceFreshness;
  /** Declared list shape (`ResourceDefinition.shape`) — surfaced in `_debug`. */
  shape?: ResourceListShape;
  /** Payload schema. The loader output is parsed against it in `timedLoad`. */
  schema: z.ZodType<unknown>;
  loader: (
    params: ResourceParams,
    ctx?: { affectedIds: readonly string[] },
    run?: LoadRun,
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
   * The current version of each TRACKED params-tuple, minted from the
   * runtime-wide clock (`mintVersion`) — present exactly while the tuple is
   * subscribed (set when its span opens, deleted at N→0), so the map is bounded
   * by the tracked tuples. Advanced in flushNotifies — a real state change —
   * and when a tracking span opens (the global 0→1 in `registerSubOnSocket`:
   * nothing tracked the tuple before it, and the clock is above every version
   * ever handed out, so no earlier version may match again). sub-acks and the HTTP fallback
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
  /** Leading-edge throttle (ms) for this entry's flushes. 0/undefined = immediate. */
  debounceMs?: number;
  /**
   * Armed throttle timer handle, or undefined when not armed. Set when a notify
   * lands inside the window opened by the last drain, for the window's
   * remainder; cleared on fire (which marks `debounceDue` and schedules a flush).
   */
  debounceTimer?: ReturnType<typeof setTimeout>;
  /**
   * A drain is allowed and a flush is scheduled for it (the leading edge, or
   * the timer fired): the only state in which `drainEntry` drains a throttled
   * entry. Cleared by that drain; a change landing while due rides the due drain.
   */
  debounceDue?: boolean;
  /**
   * `performance.now()` of this throttled entry's last drain: it opens the
   * window inside which a change waits for the remainder instead of draining.
   * Undefined until the first drain (so the first change drains at once).
   */
  debounceDrainedAt?: number;
  /**
   * `performance.now()` the window last released a drain (`debounceDue` set:
   * the leading edge, or the timer firing) — the end of every held pending's
   * `holdMs`.
   */
  debounceReleasedAt?: number;
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
  /**
   * A leaf's (no `downstream`) drain in flight off the flush loop's critical
   * path — see `runFlushPass`. One drain per entry at a time: a pass skips the
   * entry while this is set, and the lane re-arms its held work on settle.
   * Never rejects. `startedAt` (`performance.now()`) feeds `pushStall()`'s
   * `stalledResources`: the pendings it took are no longer in
   * `pendingNotifies`, and the stall is this entry's alone.
   */
  lane?: { done: Promise<void>; startedAt: number };
  /**
   * D8 — per tracked pk of a held-value entry (`holdsValue`: a pushed,
   * non-persisted value): what every holder of the tuple holds at `version`
   * — the value as served (after the schema parse, which copies, so a loader
   * mutating its own return cannot move it), and, for a `revalidate` entry
   * (a signed memo's), the loader's RAW return it came from. Set by every
   * frame that goes to all the tuple's holders (`update`, `patch`,
   * synchronously with the subscriber set it goes to), and by the sub-ack
   * that opened the tuple's span to its sole holder while no drain minted
   * since. Kept by any other read that hands a holder equal content; dropped
   * when one hands it anything else (another value, an `up-to-date`, an
   * error), when a drain's load fails, when a version is minted without a
   * frame to every holder, and at N→0. A drain whose load equals it
   * (`diffValue` → `[]`; or the very raw object, for a memo) changed
   * nothing a holder lacks: no frame, no version, only the ack it owes.
   */
  held: Map<string, HeldValue>;
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
  /**
   * The pks of a persisted alias whose snapshot may MISS a change routed to
   * it since its base: a drain took the tuple's pending and did not apply it
   * (its FULL fallback failed, or it threw), routing a change to the entry
   * threw, or the boot seed found a snapshot read before the catch-up
   * (`markUnapplied`). The floor persist keeps the
   * row's old floor for such a snapshot — catch-up replays what it missed —
   * and never advances it (`advanceRefusal`). Cleared only by a rebuild from
   * a whole read (`markRebuilt`: a FULL drain, a sub-ack seed, the L2 boot
   * seed) and with the snapshot.
   */
  unprovenBases?: Set<string>;
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
  /** See `ResourceDefinition.onFollowReached`. */
  onFollowReached?: (
    params: ResourceParams,
    follows?: HeldFollows,
  ) => Promise<FollowReached>;
  /**
   * Conditional-revalidation ETag signature (see `ResourceDefinition.revalidate`).
   * Undefined ⇒ the resource has not opted in and every read path runs the full
   * loader exactly as before.
   */
  revalidate?: (
    params: ResourceParams,
    follows?: HeldFollows,
  ) => Promise<string>;
  /** Declared read cost (`ResourceDefinition.readCost`): `"memory"` reads take no read-admission slot. */
  readCost?: ReadCost;
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
  /**
   * The holding tabs whose latest sub (or replay entry) for this tuple has
   * not been answered yet — added on registration, removed when an answer
   * addressed to the tab goes out (`noteSent`). A whole-value sub-ack answering
   * one tab is addressed to these too (`frameAudience`): a replay herd's tabs
   * then share its one copy, and are each answered `up-to-date`
   * (`alreadyShipped`) instead of sent their own.
   */
  awaiting: Set<string>;
  /**
   * What the socket was last sent of this tuple's value, while it holds it
   * (`noteSent`): `fullAt` — the socket frame number (`SocketState.framesSent`)
   * of the last frame carrying the WHOLE value (a value sub-ack, an `update`) —
   * and `version`, the version of the last frame building on it (the whole
   * value, then every `delta` / `patch`). Absent until one is sent, and
   * cleared by an `invalidate` or a `sub-error` (holders then read over HTTP,
   * outside this socket's frames). `to`: the tabs the whole value was
   * addressed to (`frameAudience`), `null` for every tab on the socket. Read
   * by `alreadyShipped`.
   */
  shipped?: {
    fullAt: number;
    version: number;
    chars: number;
    to: ReadonlySet<string> | null;
  };
}

interface SocketState {
  ws: RuntimeSocket;
  /** key -> paramsKey -> record (subscriptions this socket holds, tagged by tab). */
  subs: Map<string, Map<string, SocketSubRecord>>;
  /**
   * Frames the socket did not accept, oldest first, waiting for its `drain` —
   * and every frame sent after them, so none overtakes one held back. Absent
   * while the socket accepts every frame. See `deliver`.
   */
  backlog?: { frames: string[]; chars: number; since: number };
  /** The runtime closed it (`closeBacklogged`): nothing more is sent. */
  closing?: true;
  /**
   * How many frames were handed to `deliver` for this socket — the position of
   * the next one in its (ordered) stream. A sub's arrival is stamped with it
   * (`alreadyShipped`).
   */
  framesSent: number;
  /**
   * The socket's peer routes addressed frames (`op: "address-frames"`): from
   * then on every frame naming a tuple is addressed to the tabs it is for
   * (`frameWire`), and the peer — the tabs' SharedWorker — hands it only to
   * them. Absent: every frame goes out bare and reaches every tab.
   */
  addressed?: true;
}

/**
 * How much a socket may hold back, and for how long, before it is closed
 * instead: a peer that stopped reading. Its tabs reconnect and replay their
 * whole sub set, which re-reads every value — lossless, where holding on would
 * grow without end (or, with no `drain` ever coming, leave the tabs on stale
 * values). A 2026-11-04 restart replay of a six-tab socket was ~45 MB. The age
 * is checked on every frame, the heartbeat's included.
 */
const BACKLOG_MAX_CHARS = 64 * 1024 * 1024;
const BACKLOG_MAX_AGE_MS = 60_000;

/** One loader run's own read capture, as `RunCapture` handed it (sorted). */
interface RunReads {
  tables: readonly string[];
  tags: ReadTags | undefined;
}

/** What `wrapLoad` is told about one loader run (see `ResourceRuntimeOptions.wrapLoad`). */
export interface LoadInfo {
  variant?: string;
  scopedIds?: number;
}

/**
 * One delivered notify, as `ResourceRuntimeOptions.onDelivered` reports it.
 * `latencyMs` = first notify → send on this thread's monotonic clock (the "UI is
 * stale" window as the serving thread sees it); `subscribers` = how many sockets
 * received the frame; `frameChars` = its serialized size; `changedAt` = the
 * wall-clock epoch ms of the earliest change folded in (`PendingNotify.changedAt`)
 * — absent exactly when the frame carried no `timing`. `holdMs` = the part of
 * `latencyMs` the entry's declared throttle held the change
 * (`PendingNotify.holdMs`, 0 when none): a monitor judging the delivery takes
 * it off, as the frame's `timing.holdMs` lets a tab do.
 */
export interface ResourceDelivery {
  latencyMs: number;
  holdMs: number;
  /**
   * The part of `latencyMs` after the hold spent queued for the flush lane
   * (`PendingNotify.queueMs`): waiting on other drains. What is
   * left — `latencyMs − holdMs − queueMs` — is this resource's own drain.
   */
  queueMs: number;
  subscribers: number;
  frameChars: number;
  changedAt?: number;
}

/**
 * The `timing` field of a pushed value frame (`update` / `delta`), built at the
 * moment of send from the pending it drains: present exactly when the pending
 * knows its change time, so a frame never carries a change time without the send
 * time and server delay that split its latency into layers. `deliverMs` is the
 * same first-notify → send quantity `onDelivered` reports; `holdMs` is the part
 * of it the entry's declared throttle held the change (`PendingNotify.holdMs`).
 */
function frameTiming(pending: PendingNotify):
  | {
      timing: {
        changedAt: number;
        sentAt: number;
        deliverMs: number;
        holdMs: number;
        heardAt?: number;
      };
    }
  | Record<string, never> {
  if (pending.changedAt === undefined) return {};
  return {
    timing: {
      changedAt: pending.changedAt,
      ...(pending.heardAt !== undefined ? { heardAt: pending.heardAt } : {}),
      sentAt: Date.now(),
      deliverMs: performance.now() - pending.enqueuedAt,
      holdMs: pending.holdMs ?? 0,
    },
  };
}

/** The `onDelivered` report for a frame just sent from `pending`. */
function delivery(
  pending: PendingNotify,
  subscribers: number,
  frameChars: number,
): ResourceDelivery {
  return {
    latencyMs: performance.now() - pending.enqueuedAt,
    holdMs: pending.holdMs ?? 0,
    queueMs: pending.queueMs ?? 0,
    subscribers,
    frameChars,
    ...(pending.changedAt !== undefined
      ? { changedAt: pending.changedAt }
      : {}),
  };
}

/**
 * One loader run's reads by tag: each relation the run read, with the tag of
 * every query that read it — `null` for an untagged one. A query is tagged by
 * its SQL text (database's `tagReads`), so the capture tells a compiled
 * lookup's read of a table from any other read of it (`TaggedRead`).
 */
export type ReadTags = ReadonlyMap<string, ReadonlySet<string | null>>;

/**
 * Hand one loader run's OWN read capture to the runtime: every table its
 * loader span read (none included) and their tags (`undefined` when none was
 * tagged). Called by the host's `wrapLoad` as the run's span closes.
 */
export type RunCapture = (
  tables: ReadonlySet<string>,
  tags: ReadTags | undefined,
) => void;

/**
 * What a `ResourceDefinition.onFollowReached` hook did for one tuple: its
 * `whileFollowing` start re-pointed at the moved followed rows, or nothing
 * moved that the start reads (or the tuple was released meanwhile).
 */
export type FollowReached = "repointed" | "unchanged";

export interface ResourceRuntimeOptions {
  /**
   * The 64-bit content hash a keyed resource's snapshot retains per row (see
   * `SnapEncoder` in keyed-diff.ts — entries are only equality-compared, so any
   * well-mixed 64-bit hash works). Default: the portable `hash64` (plain JS).
   * The Bun hosts (server, central) pass `Bun.hash.wyhash(json) ^
   * BigInt(json.length)` — native speed on the delivery hot path.
   */
  snapHash?: (json: string) => bigint;
  /**
   * The machine's cumulative time asleep (ms), comparable within this process;
   * null where the host cannot tell. Only `_debug.linger`'s episodes read it,
   * to say whether a linger spanned a sleep. The desktop server passes
   * `packages/sleep-clock`'s reading; central and a browser host omit it
   * (always null).
   */
  asleepMs?: () => number | null;
  /**
   * Wrap each loader call. `info.variant` is the canonical params
   * (`paramsKey`, absent for `{}`); `info.scopedIds` is how many ids a scoped
   * refill read (absent on a FULL load). `capture` takes THIS run's own read
   * capture (`RunCapture`) as its span closes — what the drift guard judges
   * the run on (see `lastReadSet`). server: recordEntrySpan("loader", key,
   * fn, detail, capture); central: omit (identity).
   */
  wrapLoad?: (
    key: string,
    info: LoadInfo,
    fn: () => Promise<unknown>,
    capture: RunCapture,
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
   * `push` (a drain's load), `cascade` (a routed entry's reverse-route resolve,
   * `resolveReverseRoutes`) or `bg` (a follow hook's re-read,
   * `onFollowReached` — background work no reader waits on). A tuple's
   * `onFirstSubscribe` runs under `sub` labelled `start:<key>`: the sub-ack
   * waits on it, so a slow watcher start is a span of its own rather than
   * untimed time before the read. Without it the
   * loader runs with no entry context and gets `parent: null`. server:
   * recordEntrySpan(kind, key, fn);
   * central: omit (identity). See
   * research/2026-06-19-global-wait-attribution-instrumentation.md.
   *
   * `onJoined`, when given, is handed as the origin closes how much of it
   * (ms) was spent awaiting another run already in flight — a coalesced
   * flight, a shared memo's pass: that run's time, judged on its own span. A
   * sub-ack carries it (`joinedMs`) so the browser does not judge the
   * resource on it. Central / a host without a profiler: never called (0).
   */
  wrapOrigin?: <R>(
    kind: "sub" | "push" | "cascade" | "bg",
    key: string,
    fn: () => Promise<R>,
    onJoined?: (joinedMs: number) => void,
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
   * Report a delivered notify (see `ResourceDelivery`). server:
   * recordSpan("push", `deliver:${key}`, info.latencyMs); central: omit (no-op).
   * The leaf `deliver:<key>` span nests under the `flush` entry so latency
   * attributes to the resource. See the doc above.
   */
  onDelivered?: (key: string, info: ResourceDelivery) => void;
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
   * The read-admission gate's wait observers (see `READ_LOAD_CONCURRENCY`),
   * passed to its `packages/semaphore` slots: `onQueued` announces a read that
   * has to QUEUE the moment it starts waiting (the returned function is called
   * at admission), `onWait` reports the ms spent queueing at slot acquisition
   * (≈0 when a slot was free). One value, so the gate cannot report a wait it
   * never showed. server: `gateWaitHooks("read-admit")` — the wait is charged
   * to the enclosing `sub` entry, and shown while it lasts, so the stuck-span
   * watchdog files a read queued past its threshold against the gate and its
   * holders, not as the reader stuck itself; central / before-injection:
   * omitted (no-op). */
  readGateWait?: {
    onQueued: () => () => void;
    onWait: (waitMs: number) => void;
  };
  /**
   * A JOINING full load at the read-path single-flight coalescer (see
   * `getResourceValue`) — a caller that found an existing in-flight loader
   * promise for the same (key, params) — announced as it joins; the returned
   * function is called when the shared flight settles (the starter never
   * joins). server: `beginWait("read-coalesce", "join")` — shown while it
   * lasts, then charged to the joiner's own entry, so time spent coalesced
   * behind another caller's slow loader reads as a join, not as the joiner's
   * own work; central / before-injection: omitted (no-op). */
  onCoalesceJoin?: () => () => void;
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
   * The build this process's code was built from, in the identity its
   * clients name in `build` for THIS host, for judging a contract mismatch: a
   * client whose `build` differs is running another bundle (`skew` — expected,
   * a reload fixes it, only warned), one whose build matches has a real bug
   * (`same-build` — reported). Must be the identity read at BOOT, not a fresh
   * read: the code answering is the boot build's. `null` = unknown. server:
   * the web graph built alongside it (the build swaps the served dist before
   * it restarts this process), boot-injected by `build/server-build-id`
   * through `setClientBuildIdentity`; central: its own code build (the source
   * digest of its entry closure — a tab carries the one its bundle was built
   * against), boot-injected by `build/central-build-id` through
   * `setCentralBuildIdentity`.
   */
  serverBuildGraph?: () => string | null;
  /**
   * The central build the page this host SERVES was built against — what a
   * reload brings a tab, for central's values — named on every ack frame
   * (`central`), read at call time. A tab judges a central value it cannot
   * decode against it: central's own build named here, a reload fixes it
   * (`skew`); another, no reload can (`deploy-skew`: the code this host's page
   * was built from disagrees with the central that runs — reported). Pinned
   * at boot beside `serverBuildGraph`. server: the served dist's
   * `.central-build`, boot-injected by `build/server-build-id` through
   * `setServedCentralBuild`; central (it serves no page) / omitted: unnamed.
   */
  servedCentralBuild?: () => string | null;
  /**
   * Told the build graph a client says it runs, on every subscription (single,
   * batch) and HTTP read that names one — `dev` and an absent build excluded.
   * Called synchronously and often: the observer dedupes. server:
   * boot-injected by `build/server-build-id`, which marks the graph as still
   * needed so the build keeps serving that bundle's addresses; omitted: no-op.
   */
  onClientBuild?: (build: string) => void;
  /**
   * Whether this host's key set is OPEN or CLOSED, read at call time (like
   * `serverBuildGraph`). Open (the default) = a host deployed under tabs that
   * may run another bundle: an unknown key is the other face of skew
   * (`unknown-key` + a verdict, never reported). Closed = a host that ships
   * with its only client (a browser host, loaded by the same bundle that reads
   * it): an unknown key cannot be skew, so it is a bug — refused as `unserved`
   * (HTTP 404, no verdict) and reported, naming the key. server: closed by
   * `bootBrowserHost` through server-core's `closeResourceKeySet`; the desktop
   * server and central: open.
   */
  keySet?: () => "open" | "closed";
  /** Per-key owner metadata for the _debug endpoint. server: from Resource.Declare; central: omit. */
  debugOwners?: () => Array<{ key: string; pluginId?: string }>;
  /** Fired once per keyed or pushed-value recompute for >=1 subscriber, with whether it
   *  carried a content change. A `changed: false` one is a wasted no-op: an empty keyed
   *  diff, or a value recompute equal to what every holder holds (D8 — no frame went out,
   *  but the loader ran for nothing). */
  onPush?(key: string, info: { subscribers: number; changed: boolean }): void;
  /**
   * Per-key automatic table read-set: the tables this resource's loader actually
   * read (captured at the DB pool chokepoint), unioned over every run. Display
   * only — no change is routed through it: the `_debug` endpoint shows it with
   * its relation bases. (`floorGuardTables` falls back to it for an UNROUTED
   * persisted entry, which only a DB-free harness has: central persists
   * nothing, and change-feed refuses an unrouted DB-backed resource, D6.)
   * server: server-core's runtime-owned read-set sink (captured whatever the
   * profiler's kill-switch says); central: omit (field absent, nothing routes).
   */
  readSet?: (key: string) => string[];
  /**
   * The tables the resource's MOST RECENT loader run read (per-run capture,
   * REPLACED each run — not the append-only union `readSet` returns; `[]`
   * for a run that read nothing), or `undefined` if no run was captured. On
   * the L2 persist seam (an empty one falls back to the route tables): after a
   * FULL recompute, the runtime persists THIS into `tables_read` (replace, not
   * union) so a dependency a code change removed — or a historical mis-attribution
   * baked into the seed — is shed instead of carried forever. It is authoritative
   * because every persisted resource FULL-recomputes wholesale, so its last run
   * observed the complete current table set (there are no data-dependent
   * conditional queries among persisted resources — the safety basis; see
   * research/2026-07-07-global-read-set-self-heal-on-full-recompute.md).
   *
   * It also arms the route drift guard (A8 / D5): a captured relation no
   * route, relation read or unfed declaration covers is drift. The guard
   * judges a run on its OWN capture, handed back through `wrapLoad`'s
   * `capture` — a per-key last run may be another run of the key, finished
   * in between (a pure follower's empty run, a sibling tuple's) — and reads
   * this only for a run whose host handed none (a test harness without
   * `wrapLoad`). server: the read-set sink's per-run capture;
   * central: omitted (central persists nothing).
   */
  lastReadSet?: (key: string) => string[] | undefined;
  /**
   * The tags of the MOST RECENT loader run's reads (`ReadTags`), captured with
   * `lastReadSet` — or `undefined` when none of them carried a tag. The drift
   * guard reads it for a plan's tagged reads (`TaggedRead`): a route table
   * covered only by queries carrying a given tag (a compiled lookup's own SQL).
   * server: the read-set sink's per-run tags; central / DB-free harness: omit
   * (every read untagged).
   */
  lastReadTags?: (key: string) => ReadTags | undefined;
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
   * trigger-maintained rollup to its sources. A reach plan's relation reads are
   * indexed under their bases (`indexRelationReads`), the drift guard expands a
   * captured relation through it, and `_debug` shows the expansion as
   * `readSetBases`. server: injected at boot by change-feed (the
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
   * has xid >= this watermark. server: `database/server`'s `snapshotWatermark`
   * (`SELECT pg_snapshot_xmin(pg_current_snapshot())::text`), installed on every
   * host with a database through server-core's `setWatermarkSource`.
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
   * Absent (central) ⇒ frames ship tokenless and nothing is persisted. Present,
   * it always resolves a watermark: a capture that cannot answer throws, and
   * the runtime reports it and ships that one frame tokenless.
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
   *    `meta.guardTables` (the entry's route tables, or its read-set union);
   *  - `advance` — a `floor` persist after a routed cut proved the snapshot
   *    holds every change below `cutXid` (`routedCut`): the position is SET
   *    to the cut, so the next boot replays only what came after it.
   *
   * Every mode writes `meta.definition` (A18). `meta.guardTables` is what the A6
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
  /**
   * A routed-through cut, for raising a persisted alias's catch-up floor
   * (`PersistMeta` mode `advance`): `cut` promises that every change of every
   * transaction with an xid below `cutXid` that will ever reach this runtime
   * through `routeTableChange` HAS reached it (routing is synchronous, so the
   * pending it made exists) — the live ones, and every one committed before
   * this process listened, which the boot catch-up replays to every tuple
   * whose base it does not reflect (a snapshot read before the catch-up is
   * judged by its row's floor, not its own: the boot seed marks it unproven
   * instead — `seedPersistedSnapshot`). `unproven`
   * (with why) whenever that cannot be shown; the floor persist then lowers
   * the floor as before. server: live-state-snapshot over change-feed's
   * `feedCut`, refused until its boot catch-up has routed; central / omitted:
   * no floor is ever advanced.
   */
  routedCut?: () => Promise<RoutedCut>;
  /**
   * The epoch handoff's successor half: the record the backend that served
   * boot `epoch` wrote at its shutdown (`ResourceRuntime.handoffState`), or
   * `null` when there is none. Called at most once per foreign epoch at a
   * time, on the first sub echoing it. With it a replayed sub of an unchanged
   * tuple is answered `up-to-date` across a restart (see `EpochHandoff`).
   * server: live-state-snapshot's handoff table, read lazily; central /
   * omitted: every foreign echo takes the full path, as before.
   */
  resumeEpoch?: (epoch: string) => Promise<ResumeRecord | null>;
  /**
   * How long a `resumeEpoch` answer of "no record" is kept before a sub of
   * that epoch asks again (ms). Default 2000. A test passes 0.
   */
  resumeNoRecordRetryMs?: number;
}

/**
 * One tuple the old backend vouches for at its cut (`handoffState`): a
 * client echoing `(epoch, version)` for it holds the value the old backend
 * would have answered `up-to-date` at the cut.
 */
export interface HandoffTuple {
  key: string;
  pk: string;
  params: ResourceParams;
  version: number;
  /** The entry's definition when it served the tuple — inherited only under an equal one. */
  definition: string;
}

/** What a backend hands its successor (see `ResourceRuntime.handoffState`). */
export interface HandoffState {
  epoch: string;
  tuples: HandoffTuple[];
}

/** Why a replay could not prove the restart gap — every tuple then loads. */
export type ResumeReplayOutcome = { ok: true } | { ok: false; reason: string };

/** A handoff record, as the successor reads it (`ResourceRuntimeOptions.resumeEpoch`). */
export interface ResumeRecord {
  tuples: readonly HandoffTuple[];
  /**
   * The tables whose every committed change is in the changelog `replay`
   * reads (the trigger-covered set). A tuple reading any other table — a
   * produced one, an opted-out one — cannot be proven and is not inherited.
   */
  changelogTables: ReadonlySet<string>;
  /**
   * Route every change committed since the record's cut through `route`
   * (synchronously, in commit order of the changelog), or say why the gap
   * cannot be proven (history pruned past the cut, a healed rollup). Called
   * AFTER the shadows are installed, so a change committed after its read is
   * routed live.
   */
  replay(route: (change: TableChange) => void): Promise<ResumeReplayOutcome>;
}

/** A routed-through cut, or why none could be proven — see `ResourceRuntimeOptions.routedCut`. */
export type RoutedCut =
  { kind: "cut"; cutXid: string } | { kind: "unproven"; reason: string };

/** How one L2 persist writes its row — see `ResourceRuntimeOptions.persistSnapshot`. */
export interface PersistMeta {
  /**
   * `replace` / `floor` — see `persistSnapshot`. `advance`: a floor persist
   * whose `watermark` is a routed cut (`routedCut`) the alias's snapshot was
   * proven settled under — every change below it applied — so the row's
   * position is SET to it (raised, not `LEAST`ed); `position_at` and
   * `tables_read` are kept as in `floor`.
   */
  mode: "replace" | "floor" | "advance";
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

/** One table a reach plan reads outside the change feed (see `unfedResourceTables`). */
export interface UnfedResourceTable {
  key: string;
  table: string;
}

/** One relation a reach plan reads whole (see `relationResourceReads`). */
export interface RelationResourceRead {
  key: string;
  relation: string;
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
 * compiler-emitted routes, or — refused at change-feed boot (D6) — none.
 */
type DebugPolicy = "unbound" | "external" | "routed" | "unrouted";

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
   *
   * The third arm (D4) is a deferred EXTERNAL value — one whose declared reads
   * are computed from contributions (a provider registry): `external` fixes,
   * at definition, its externality, its mode and its freshness, so the
   * placeholder is external from the start (`_debug`, the read-set-gap
   * warning, the D5 guard) and returns a handle with `notify`; its bind
   * supplies the loader and the `reach` plan, and may not restate another
   * freshness.
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
    <T, P extends ResourceParams = ResourceParams>(
      contract: ResourceContract<T, P> & { keyed?: never },
      bind: () => ServerResourceOptions<T, P>,
      external: DeferredExternal,
    ): ExternalResource<T, P>;
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
   * - Two-arg `(keyedContract, opts & ExternalKeyedPolicy)` — a keyed
   *   bounded window (`ExternalWindowPolicy`) or point set
   *   (`ExternalPointPolicy`): `notify(params)` re-reads the tuple and ships
   *   its keyed diff, and a window's sub may be seeded from tuples of the
   *   same family.
   *
   * Never keyed-ROUTED (D31): an external resource's truth is outside
   * Postgres, so no `routes` plan routes into it — its own `notify` is how a
   * change arrives. A non-keyed one whose loader ALSO reads Postgres declares
   * those reads as a `reach` plan (D1): a write to one FULL-recomputes its
   * subscribed tuples, merged with its notifies. A keyed external (window /
   * point) may too: every reach route is `full`, so a reached tuple is
   * re-read whole, as its notify would.
   */
  defineExternalResource: {
    // No `optionalParams` on the flat form: the spelling rule must come from the
    // shared client descriptor (the two-arg form), or the client would key
    // tuples the server's echoes never match. No `routes` / `reach` either: the
    // flat form has no production caller, and a declared read is the two-arg
    // non-keyed form's.
    <T, P extends ResourceParams = ResourceParams>(
      def: ExternalDefinition<T, P>,
    ): ExternalResource<T, P>;
    <T, P extends ResourceParams = ResourceParams>(
      contract: KeyedResourceContract<T, P>,
      opts: KeyedServerResourceOptions<T, P> & ExternalKeyedPolicy<P>,
    ): ExternalResource<T, P>;
    <T, P extends ResourceParams = ResourceParams>(
      contract: ResourceContract<T, P> & { keyed?: never },
      opts: ServerResourceOptions<T, P>,
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
   * Read one tuple of a registered resource FRESH: its own loader, through
   * `timedLoad` (its own loader span — so the reads are captured under ITS
   * key and judged by ITS drift guard —, the schema parse), never joining an
   * in-flight read, capturing no watermark and touching no subscription,
   * snapshot or version. For a read another resource composes into its own
   * load (network/live's `follows`): the caller's flight already began after
   * the change it serves, so a joined older flight would be a stale read under
   * a fresh version. Throws on an unknown key, an unbound deferred one and a
   * tuple its params gate refuses.
   */
  loadResourceFresh: (key: string, params: ResourceParams) => Promise<unknown>;
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
   * Route one base-table change to the ROUTED entries (those declaring `routes`)
   * that read the table: per subscribed tuple, only the route occurrences that
   * tuple's `usesOf` names, mapped to host ids by each route's `HostMap` — so a
   * side-table write costs O(changed) and reaches only the tuples whose query
   * reads that table. A tuple the change skips owes at most an ack. Synchronous,
   * SQL-free and producer-agnostic (every producer calls it; reverse routes
   * resolve later, in the drain). Never throws. An entry with no plan is reached
   * by no table change (D6: change-feed refuses one at boot).
   * See research/2026-09-29-global-scoped-change-routing.md.
   *
   * `replay` (the L2 boot catch-up only, see `ReplayScope`): a persisted
   * entry's `{}` tuple skips the change when its xid is below the floor its L2
   * row proves, since the value already reflects it. Every other target routes as a live change.
   */
  routeTableChange: (change: TableChange, replay?: ReplayScope) => void;
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
   * `read-admit` gate gauge; central omits the registration. `holders` names
   * the reads holding a slot now (`<key> <params>`, a signature probe
   * `revalidate <key> <params>`), longest-held first — who a queued read is
   * waiting behind.
   */
  readGateStats: () => {
    active: number;
    queued: number;
    max: number;
    holders: SlotHolder[];
  };
  /**
   * Every table a registered resource's routed delivery depends on: one row per
   * route of a ROUTED entry (`routes` / `reach` — every table it may read, since
   * only a change to one of them can reach it). The change-feed cross-checks these against the tables it installed
   * triggers on at boot (A1): a table with no trigger can NEVER produce the
   * change the resource waits for, so the declaration is dead config that
   * silently degrades the resource to hydrate-on-mount with zero signal. The
   * runtime owns the registry; the change-feed owns the trigger set — this
   * accessor is the seam that lets the change-feed (the DB↔live-state wirer)
   * enforce the invariant without the runtime importing a specific DB plugin.
   */
  scopedResourceTables: () => ScopedResourceTable[];
  /**
   * Every table a reach plan reads outside the change feed by declaration
   * (`ReachPlan.unfed`), with its resource key — change-feed's boot check
   * refuses one the feed does cover (its writes would be missed, not declared
   * away). Call after `bindDeferredResources()`.
   */
  unfedResourceTables: () => UnfedResourceTable[];
  /**
   * Every relation a reach plan reads whole (`ReachPlan.relations`), by key —
   * for change-feed's boot check, which expands each through the relation
   * graph and holds every base to the same rule as a route table (a change
   * source: a trigger or a producer). Readable before the relation bases are
   * set. Call after `bindDeferredResources()`.
   */
  relationResourceReads: () => RelationResourceRead[];
  /**
   * Every registered DB-backed (non-external) entry that declares no plan —
   * neither `routes` nor `reach` — so no table change reaches it, sorted.
   * Deferred placeholders not bound yet are left out (call after
   * `bindDeferredResources()`). A keyed DB-backed entry is always routed
   * (`buildEntry`), so every key here is a non-keyed value. D6: change-feed
   * refuses boot on a non-empty answer (not `createResource`, since a DB-free
   * test resource is legitimately unrouted).
   */
  unroutedResourceKeys: () => string[];
  /**
   * Index every routed entry's relation reads (`ReachPlan.relations`) under
   * their relation bases, so a write to any base recomputes the entry FULL;
   * every entry registered or bound later expands its own. A re-index (the
   * bases an earlier call indexed are dropped first), so idempotent over one
   * graph. Call once the relation bases are set (server-core's
   * `setRelationBases` does).
   */
  indexRelationReads: () => void;
  /**
   * Undo `indexRelationReads`: drop every relation read's bases from the
   * router's index (a drifted read's stay), until the next call. server-core's
   * `clearRelationBases` (test support) calls it, so a suite that cleared the
   * bases never leaves the next one expanding through them — or throwing on
   * the cleared holder.
   */
  resetRelationReads: () => void;
  /**
   * D7: seed the drift guard from each persisted entry's durable
   * `tables_read` — every relation its declaration does not cover (the same
   * predicate a load is judged by: routes, derived reads, unfed tables,
   * relation reads) fails open on its bases, unreported and not counted as
   * covered, so the next load re-judges it (`_debug.routeDriftSeeded`).
   * Returns the seeded relations per key. Call at boot after
   * `bindDeferredResources()` and once the relation bases are set, before
   * catch-up replays.
   */
  seedRouteDrift: (
    persisted: ReadonlyArray<{ key: string; tablesRead: readonly string[] }>,
  ) => Array<{ key: string; tables: string[] }>;
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
  /**
   * The epoch handoff's old-backend half: every tuple this process would
   * answer `up-to-date` right now and whose value no change has yet to reach
   * — a tracked tuple of an inheritable entry (see `EpochHandoff`) holding a
   * snapshot, with no pending notify and not draining — at its version. Taken
   * right after a feed cut (change-feed's `feedCut`), so every change below
   * the cut has already made its pending: a tuple a change reached is left
   * out, and loads in the successor.
   */
  handoffState: () => HandoffState;
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

// How many stalled resources one ping names (the oldest first): a hung
// filesystem can hold several leaves at once, and the row names a few at most.
const STALLED_RESOURCES_MAX = 5;

// How long a closed socket's subs stay held for its tabs to replay them on a
// new socket (the runtime's `detached` linger). The client reconnects after
// 0.25–0.75 s, then backs off to at most 7.5 s (networking's
// `reconnect-backoff`), so a few attempts fit; the bound only matters for a
// tab that never comes back, whose tuples stay tracked — read on a change,
// pushed to nobody — until it passes.
export const SOCKET_LINGER_MS = 30_000;

// How recently a commit-watermark capture must have started for a flight to
// share it (`captureSharedWatermark`): long enough to span one herd wave of
// cold reads (an xmin round trip measured ~18 ms under boot load), short
// enough that a hung capture is superseded rather than waited on by every read.
const WATERMARK_SHARE_MS = 100;

// Read-admission concurrency cap. Bounds how many COLD read-path loads (WS
// sub-ack + HTTP GET fallback) — and the `revalidate` git/fs spawns they may run
// first — execute at once, so no fan-out (boot, a post-restart resubscribe herd,
// or the genuinely-dirty residual after conditional revalidation) can ever
// stampede more than N cold read-loads simultaneously. Orthogonal to the DB
// loader gate (that bounds DB connections; this bounds the whole read-path unit,
// including git/fs-only loaders that issue no query). The push/flush cascade is
// deliberately NOT gated here — it stays level-parallel, bounded by the DB gate.
// Tunable; surfaced via `get_runtime_profile`'s read-admit wait spans.
//
// The slot counts reads that RUN, not reads that wait: it is `yieldable`, so a
// read that only waits on work another caller is doing (an `inflight` join —
// a shared memo's compute, another resource's flight) gives it back for the
// wait and takes it back ahead of every newcomer. Otherwise six reads waiting
// on one slow read hold all six slots, and every unrelated read queues behind
// that one read (main, 2026-11-03: 131 reads waited ~12 s on one transcript).
// research/2026-11-03-framework-read-admission-waiters-yield.md
const READ_LOAD_CONCURRENCY = 6;

// The most read-admission slots ONE resource key may hold at once (the gate's
// `perClass`, each read's class its key): a key at its share has its next read
// passed over while every other key's reads keep their FIFO place, so one slow
// resource class cannot take the whole gate: main, 2026-11-05
// 00:59–01:05Z, 15 `host-fs.peek` loads from one File Explorer tab hung ~94 s
// in readdir and held all 6 slots — 73 reads queued, 121 `reports.list` subs
// waited 93 s, and the app loaded without data. With a share of half, a hung
// key leaves the other half to every other key. A hard cap, not a fair-share
// scheduler: a slot is held for the whole load, so a key that took every free
// slot while the gate was idle would still starve whoever came next. One gate,
// so a read waiting on another's work (`whileWaiting`) gives back its key's
// share with its slot — a second, non-yieldable per-key gate around it could
// deadlock two keys' reads waiting on each other's queued flights.
const READ_KEY_SHARE = 3;

// The longest a `readCost: "memory"` read may take before its declaration is
// reported as broken (`checkMemoryRead`): far above a memory read (a lookup,
// a slice of a held list — well under 10 ms), far below any I/O the gate
// exists to bound under load. A memo's one cold build per process may cross
// it, which is why a read of a tuple not yet warm is exempt.
const MEMORY_READ_BUDGET_MS = 250;

// The most tuples one `readCost: "memory"` key remembers as warm
// (`settleMemoryRead`): a key with many tuples (a picker's symbol batches)
// starts over past it rather than growing for the life of the process.
const MEMORY_READ_WARM_MAX = 1024;

/**
 * Who a gated read is for: a tuple's subscription (`sub` — owed only while
 * the tuple is tracked) or an HTTP read (owed until it answers).
 */
type GatedReader = "sub" | "http";

/**
 * A subscription's read that reached its read-admission slot after every
 * subscriber of the tuple left. Thrown instead of running the loader, so a
 * read nobody will receive costs the gate nothing but its queue place (a tab
 * scrolling a per-row list queues one cold read per row, and unsubscribes
 * most of them before they are admitted). Caught by `serveSub`, which sends
 * nothing: no socket holds the tuple to receive it.
 */
class ReadAbandoned extends Error {
  constructor(key: string) {
    super(`read of ${key} abandoned: no subscriber left`);
    this.name = "ReadAbandoned";
  }
}

/**
 * A subscription's `revalidate` probe, shareable while it waits for its
 * read-admission slot (see `computeEtag`).
 */
interface QueuedProbe {
  read: Promise<string>;
}

/** The single-flight key of one tuple's read. */
function flightKeyOf(key: string, pk: string): string {
  return `${key} ${pk}`;
}

// Longest params text a read-admission holder label keeps: enough to tell
// one row's read from another, short enough for a trace and a slow-op sample.
const GATE_LABEL_PARAMS_MAX = 120;

/** How a read holding a read-admission slot is named (`SlotOptions.label`). */
function gateLabel(key: string, pk: string): string {
  if (pk === EMPTY_PK) return key;
  const params =
    pk.length > GATE_LABEL_PARAMS_MAX
      ? `${pk.slice(0, GATE_LABEL_PARAMS_MAX - 1)}…`
      : pk;
  return `${key} ${params}`;
}

/** A reach plan's follows by table: every follow (by name) reading each one. */
function followsByTable(
  routes: readonly Route[],
): ReadonlyMap<string, readonly RouteVia[]> {
  const out = new Map<string, RouteVia[]>();
  for (const route of routes) {
    if (route.via === undefined) continue;
    const vias = out.get(route.table) ?? [];
    if (!vias.some((v) => v.name === route.via!.name)) vias.push(route.via);
    out.set(route.table, vias);
  }
  return out;
}

/** `the follow "a" of "x"` / `the follows "a" of "x" and "b" of "y"`, for a message. */
function namedFollows(vias: readonly RouteVia[]): string {
  const each = vias.map((v) => `"${v.name}" of "${v.collection}"`);
  return vias.length === 1
    ? `the follow ${each[0]}`
    : `the follows ${each.join(" and ")}`;
}

// A resource's `revalidate` may return ANY string — long, and with bytes
// (NUL/newline) that are illegal in an HTTP `ETag` header value and unstorable in
// Postgres text (a raw signature set as a header throws `TypeError: Header has
// invalid value`, escaping the handler as a 500). Normalize every signature into
// a compact, opaque, header-safe token by hashing it centrally here — so the
// token is identical across the WS and HTTP paths and every present/future
// resource is protected regardless of what its signature contains. The client
// treats the token as opaque, so hashing is transparent to comparison.
function normalizeEtag(raw: string): string {
  return hashHex(raw);
}

// The most host ids one reverse route may resolve to in one flush before its
// reading tuples recompute FULL instead (a bounded window load, for a window).
// Handed to the route's own `resolve`, which answers "over-cap" past it.
const REVERSE_RESOLVE_CAP = 500;

// `paramsKey({})` — the one tuple of a param-less resource.
const EMPTY_PK = "{}";

/**
 * The request a frame answers: the asking tab's own frame `id` and its
 * `tabId`. Ids are minted per tab, so only the pair names one request on a
 * shared socket — every answer (`sub-ack`, `up-to-date`, `sub-error`) echoes
 * both, and a tab counts a frame as the answer to its sub only when both match.
 */
interface SubRequest {
  id: number | undefined;
  tabId: string | undefined;
}

function subRequestOf(m: { id?: number; tabId?: string }): SubRequest {
  return {
    id: typeof m.id === "number" ? m.id : undefined,
    tabId: typeof m.tabId === "string" ? m.tabId : undefined,
  };
}

export function createResourceRuntime(
  opts: ResourceRuntimeOptions = {},
): ResourceRuntime {
  const registry = new Map<string, RegistryEntry>();
  const inflight = createInflight();
  // The runtime-wide version clock: the last version handed out, for any
  // tuple of any entry. Every version is minted from it (`mintVersion`, the
  // span opener in `registerSubOnSocket`), so a version is never reused —
  // which is what lets a tuple's version die with its span (`versions` is
  // deleted at N→0) while an old tab still holds it: whatever span opens next
  // opens above every version ever handed out. Tracking spans are numbered
  // by the same clock (`RegistryEntry.spans` holds the span opener's version).
  let versionClock = 0;

  // A real state change of a tuple: the next version. Stored only while the
  // tuple is tracked (`versions` lives exactly as long as its span) — a mint
  // for an untracked tuple (a persisted `{}` recomputed with nobody
  // subscribed, a drain that outlived its span) is reported, never kept.
  function mintVersion(entry: RegistryEntry, pk: string): number {
    const version = ++versionClock;
    if (entry.tracked.has(pk)) entry.versions.set(pk, version);
    return version;
  }

  // The version a READ reports for a tuple: its current version while
  // tracked, else the clock — above every version a client was ever handed for
  // it, so a WebSocket-down HTTP body is never dropped as older than what the
  // tab holds, and below every version a later span mints, so no later
  // short-circuit can match it. Comparisons read `entry.versions` directly:
  // an untracked tuple equals nothing.
  function versionOf(entry: RegistryEntry, pk: string): number {
    return entry.versions.get(pk) ?? versionClock;
  }
  // Per-runtime read-admission gate (see READ_LOAD_CONCURRENCY). Its waits are
  // announced and charged to the enclosing entry via the injected
  // `readGateWait` (server: `gateWaitHooks("read-admit")`), so a saturated gate
  // is observable rather than hidden.
  const readLoadGate = createSemaphore(READ_LOAD_CONCURRENCY, {
    perClass: READ_KEY_SHARE,
  });
  // Identity of THIS server boot, stamped on every sub-ack / up-to-date frame.
  // `entry.versions` is per-boot in-memory state (created empty at registration,
  // bumped only in the flush paths — nothing restores it across restarts), so a
  // client-echoed version is comparable ONLY when the epochs match: same epoch +
  // same version ⇒ for a resource whose counter is complete
  // (`versionIsComplete`), no state change since the
  // client's value was produced — the per-pk version counter is its complete
  // change signal. See the version short-circuit in `handleSub`.
  const bootEpoch = globalThis.crypto.randomUUID();
  // The boot identity every ack frame and HTTP read envelope carries: the
  // epoch, and the build graph this server's code was built from — what shapes
  // every value it sends. A tab whose own schema rejects a value judges the
  // failure against `graph` (`contractVerdict`): another build is skew (the tab
  // is out of date — a reload fixes it), the same build a real bug. Read per
  // frame, not captured here: the graph is boot-injected after the runtime is
  // built (`serverBuildGraph` returns the value memoized at boot). Absent when
  // the server cannot say, which the tab judges `unknown` — loud.
  function bootIdentity(): { epoch: string; graph?: string } {
    const graph = opts.serverBuildGraph?.() ?? null;
    return graph === null ? { epoch: bootEpoch } : { epoch: bootEpoch, graph };
  }
  // An ack frame's identity: the boot identity, plus — from a host serving a
  // page — the central build that page was built against (`central`,
  // `servedCentralBuild`): what a reload brings a tab for central's values, so
  // it can tell a central value it cannot decode that a reload fixes (the
  // served page names central's build) from one no reload can (the code this
  // host's page was built from disagrees with the central that runs).
  function ackIdentity(): { epoch: string; graph?: string; central?: string } {
    const central = opts.servedCentralBuild?.() ?? null;
    return central === null ? bootIdentity() : { ...bootIdentity(), central };
  }
  // Per-key count of version short-circuits (a sub answered `up-to-date` from
  // memory: zero loader runs, zero read-admission slots). Monotonic; surfaced in
  // the `_debug` payload next to notifyStats for live re-validation.
  const subShortCircuits = new Map<string, number>();
  // Per-key count of subs answered `up-to-date` across a restart by the epoch
  // handoff, and why a handoff could not answer one (see `EpochHandoff`).
  // Monotonic; surfaced in the `_debug` payload.
  const resumedSubs = new Map<string, number>();
  const resumeRefusals = new Map<string, number>();
  function recordResumeRefusal(reason: string, n = 1): void {
    resumeRefusals.set(reason, (resumeRefusals.get(reason) ?? 0) + n);
  }
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
  // Per-key count of reads that reached a read-admission slot with nobody
  // left to answer (`ReadAbandoned`). Monotonic; surfaced in `_debug`.
  const abandonedReads = new Map<string, number>();
  // Subscription `revalidate` probes still queued for a read-admission slot,
  // per flight (`flightKeyOf`): a probe of the same tuple arriving meanwhile
  // shares its signature read (`computeEtag`). Deleted the moment the probe
  // is admitted. `sharedProbes` counts, per key, the probes that rode one
  // (no slot, no signature read); monotonic, surfaced in `_debug`.
  const queuedProbes = new Map<string, QueuedProbe>();
  const sharedProbes = new Map<string, number>();
  // Per flight (`flightKeyOf`): how many callers awaiting it are NOT a
  // tuple's subscription — an HTTP read, a push drain that joined it. Their
  // want is invisible to `entry.tracked`, so a queued read counts them before
  // it concludes nobody is left (`readWanted`).
  const untrackedFlightReaders = new Map<string, number>();
  // How many times a socket's buffer filled and the runtime held frames for
  // its drain (`deliver`), this boot.
  let backlogEpisodes = 0;
  function recordStaleFlightSupersede(key: string): void {
    staleFlightSupersedes.set(key, (staleFlightSupersedes.get(key) ?? 0) + 1);
    opts.onStaleFlightSupersede?.(key);
  }
  // Per-key seeded derivations (see `deriveSub`): subs answered from rows the
  // client already held (no load), and the ones that asked but fell back to a
  // load, by reason. Monotonic; surfaced in the `_debug` payload — a high
  // fallback count under one reason is where a paged read pays full loads.
  const derivedSubs = new Map<string, number>();
  // Per-key subs a socket's own frames already answered (`answerShipped`):
  // another tab on the same socket was sent the value after this sub arrived,
  // so this one got `up-to-date` instead of its own copy. And the chars of the
  // value-carrying sub-acks sent per key — what a replay costs on the wire.
  // Monotonic; surfaced in the `_debug` payload.
  const subAcksShared = new Map<string, number>();
  const subAckChars = new Map<string, number>();
  // …and the chars of the whole-value frame each shared answer pointed to:
  // about what that sub would have cost had it been sent its own copy.
  const subAckCharsSaved = new Map<string, number>();
  // Per-key drained tuple-cycles whose ack was suppressed because their
  // sourceTx union crossed `SOURCE_TX_CAP` (a pending's `sourceTxOverflow`, or
  // a standalone owed ack's `overflow`). Monotonic; surfaced in the `_debug`
  // payload — non-zero means an optimistic op on that key waited for the
  // watermark backstop instead of its exact ack.
  const ackOverflows = new Map<string, number>();
  // Per-key follow re-points (`onFollowReached` answering `"repointed"`): a
  // `whileFollowing` start moved to the followed rows a change moved.
  // Monotonic; surfaced in the `_debug` payload.
  const followRepoints = new Map<string, number>();
  // Per-key follow reads answered from the tuple's held rows (`HeldFollows`)
  // instead of a nested load, and per-key held reads a routed change dropped
  // (`reachFollows`). Monotonic; surfaced in the `_debug` payload.
  const followHeldHits = new Map<string, number>();
  const followHeldDrops = new Map<string, number>();
  function recordAckOverflow(key: string): void {
    ackOverflows.set(key, (ackOverflows.get(key) ?? 0) + 1);
  }
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
  const sockets = new Map<RuntimeSocket, SocketState>();
  // Linger: a CLOSED socket's state, its subs still held, with the timer that
  // releases what is left of it at the bound. A close is not a tab leaving (a
  // tab leaving says so: its `unsub-tab` will), so the tab is expected back on
  // a new socket — a network blip, a wake from sleep, a worker restart. Until
  // then every tuple it held stays TRACKED (routed, notified, watched), so a
  // change in the gap still mints a version and the replay's echoed version
  // matches only when nothing changed: the same-socket short-circuit, carried
  // across the gap, for every resource kind. A detached record is released
  // when its tab's complete replay registered on another socket, when its
  // tab's `unsub-tab` arrives, or at `SOCKET_LINGER_MS`. Never sent to:
  // senders walk `sockets` only.
  // research/2026-11-04-global-live-reconnect-linger-and-version-clock.md
  const detached = new Map<SocketState, ReturnType<typeof setTimeout>>();
  // What each linger did, for `_debug.linger` (`linger-ledger.ts`).
  const lingerLedger = createLingerLedger(opts.asleepMs ?? (() => null));
  // The flush scheduler, as ONE state whose every transition is synchronous:
  //   idle    — nothing pending a flush;
  //   queued  — a `flushNotifies` microtask is pending;
  //   running — a flush loop is mid-pass;
  //   rerun   — mid-pass, and a notify asked for another pass.
  // So `queued` always has a microtask behind it and `running` / `rerun` a live
  // loop that reads the state again — there is no value meaning "a flush was
  // asked for and nobody will run it". The three booleans this replaced had one
  // (2026-10-26, main pushed nothing for 7 min): the loop checked its rerun flag
  // a few microtask hops before the mutex was released (the async flush wrapper
  // unwinding), and a notify landing in that gap left `flushScheduled` true with
  // no flush coming — every later notify returned at `scheduleFlush`'s first line.
  // research/2026-10-26-framework-live-push-wedge-stranded-flush.md
  type FlushState = "idle" | "queued" | "running" | "rerun";
  let flushState: FlushState = "idle";
  // The state as it is NOW. A pass awaits, and a notify meanwhile moves the state
  // (`running` → `rerun`); read through this after an await, since tsc keeps the
  // narrowing from the last assignment across it.
  function currentFlushState(): FlushState {
    return flushState;
  }
  // `performance.now()` when the live flush last made progress — stamped when it
  // takes the mutex and re-stamped at the start of every re-drain pass; `null`
  // while no flush runs. A flush whose loader never settles (a DB query whose
  // socket was closed underneath it) holds the mutex forever, queueing every
  // later push behind it while pings keep flowing. Per PASS, not per mutex hold:
  // a steady notify stream keeps one hold alive across many short, delivering
  // passes, and that is not a stall.
  // research/2026-09-11-global-live-updates-frozen-by-stray-fd-close.md
  let flushPassStartedAt: number | null = null;
  // How long the changes this runtime owes its sockets have gone undelivered,
  // split by who holds them — the heartbeat's payload, the one frame that still
  // reaches the tab while pushes are stuck.
  //
  // `pushStallMs` — every push stopped (0 when nothing is owed that way). Two
  // ways a change waits on the whole runtime: inside a flush pass that does
  // not settle (the pass's age), or queued with no flush ever starting to take
  // it (its pending's `enqueuedAt`) — an open `withNotifyBatch` that never
  // settles holds every entry's flush, so no pass opens at all; so did a
  // stranded scheduler request before `flushState` (2026-10-26: 7 min of no
  // pushes behind a 0 flush age). A debounced entry's held pending is owed for
  // at most its window, far below any stall threshold.
  //
  // `stalledResources` — ONE resource stopped while every other push flows: a
  // leaf's drain off the critical path (`lane`) holds only its own entry. It
  // took its pendings out of `pendingNotifies`, and the ones landing meanwhile
  // wait for it (a pass skips an entry whose lane is in flight), so the lane's
  // start and those pendings are that resource's age, never the runtime's.
  // A lane whose load hangs (2026-11-05: `host-fs.peek` on a stuck filesystem,
  // 93 s) is named, instead of reading as the whole app frozen. The oldest
  // `STALLED_RESOURCES_MAX`, oldest first.
  // O(entries + pendings), once per heartbeat.
  function pushStall(): {
    pushStallMs: number;
    stalledResources: { key: string; ms: number }[];
  } {
    const now = performance.now();
    let oldest = flushPassStartedAt ?? now;
    const lanes: { key: string; ms: number }[] = [];
    for (const entry of registry.values()) {
      let entryOldest = entry.lane ? entry.lane.startedAt : now;
      for (const pending of entry.pendingNotifies.values()) {
        if (pending.enqueuedAt < entryOldest) entryOldest = pending.enqueuedAt;
      }
      if (entry.lane)
        lanes.push({ key: entry.key, ms: Math.round(now - entryOldest) });
      else if (entryOldest < oldest) oldest = entryOldest;
    }
    lanes.sort((a, b) => b.ms - a.ms || (a.key < b.key ? -1 : 1));
    return {
      pushStallMs: Math.round(now - oldest),
      stalledResources: lanes.slice(0, STALLED_RESOURCES_MAX),
    };
  }
  let batchDepth = 0;
  const heartbeats = new Map<RuntimeSocket, ReturnType<typeof setInterval>>();

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

  // The base tables a read of `relation` depends on (C30, `opts.relationBases`;
  // identity on central and in the DB-free harness). Read by the routed
  // router's relation reads (`indexRelationReads`), the drift guard's fail-open
  // (`driftBasesOf`) and `_debug`. Server-core's holder throws until change-feed installs
  // the graph at boot.
  const relationBasesOf =
    opts.relationBases ?? ((relation: string): readonly string[] => [relation]);

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
        new ResourceGuardError(
          "NonCanonicalParams",
          key,
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
  /** Hand a client's named build to the `onClientBuild` observer. */
  function noteClientBuild(clientBuild: string | undefined): void {
    if (clientBuild === undefined || clientBuild === DEV_BUILD) return;
    opts.onClientBuild?.(clientBuild);
  }

  function unknownKeyVerdict(clientBuild: string | undefined): ContractVerdict {
    return contractVerdict(clientBuild, opts.serverBuildGraph?.() ?? null);
  }

  /**
   * Why a key no resource is registered under is refused, by the host's key
   * set (`keySet`): open → `unknown-key` with its skew verdict, unreported;
   * closed → `unserved`, reported — the page asked its own host for a key the
   * host does not ship, a bug no reload fixes.
   */
  function refuseUnknownKey(
    key: string,
    clientBuild: string | undefined,
  ):
    | { reason: "unknown-key"; verdict: ContractVerdict }
    | { reason: "unserved" } {
    if ((opts.keySet?.() ?? "open") === "open") {
      return { reason: "unknown-key", verdict: unknownKeyVerdict(clientBuild) };
    }
    reportLoaderError(
      `unserved key ${key}`,
      new ResourceGuardError(
        "UnservedKey",
        key,
        `${key} is not served by this host: its key set is closed (it ships with its only client), so a read of a key it does not register is a bug, not skew`,
      ),
    );
    return { reason: "unserved" };
  }

  /**
   * Run `entry`'s params gate for a WS sub. On a refusal it sends the
   * `sub-error` itself and returns true; the caller must then neither
   * authorize, register nor load. A gate that throws something other than
   * `ResourceContractError` is a bug in the gate: reported, refused as
   * `loader-failed`.
   */
  function refuseSubParams(
    ws: RuntimeSocket,
    entry: RegistryEntry,
    req: SubRequest,
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
          ...req,
          key: entry.key,
          params,
          reason: "contract-mismatch",
          verdict,
        });
      } else {
        reportLoaderError(`validateParams failed for ${entry.key}`, err);
        sendJson(ws, {
          kind: "sub-error",
          ...req,
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
   * the caller's own failure handling runs. `asker`: the sub whose read hit
   * it — its socket's copy names that request, since this broadcast is also
   * its answer.
   */
  function evictOnContractError(
    entry: RegistryEntry,
    params: ResourceParams,
    err: unknown,
    asker?: { state: SocketState; req: SubRequest },
  ): boolean {
    if (!(err instanceof ResourceContractError)) return false;
    reportLoaderError(
      `contract mismatch past the params gate for ${entry.key} (validateParams accepted params the loader refuses)`,
      err,
    );
    unregisterTupleEverywhere(entry.key, params, (state) =>
      sendJson(state.ws, {
        kind: "sub-error",
        ...(asker?.state === state ? asker.req : {}),
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
  // removed or a historical mis-attribution left behind), falling back, when no
  // run captured a table, to what `floorGuardTables` judges: a routed entry's
  // route tables (its reads by declaration — an empty `tables_read` would force
  // a FULL recompute at the next boot), else the accumulated union (an unrouted
  // entry: a DB-free harness only — see `floorGuardTables`). REPLACE semantics: the
  // persist SQL sets `tables_read = EXCLUDED`, so feeding it the per-run set here is
  // what makes the durable seed converge. The in-memory union (`opts.readSet`) is
  // left untouched (display). Must be read SYNCHRONOUSLY right
  // after awaiting the loader; every persisted resource is param-less (single pk),
  // so no concurrent same-key run can clobber the per-run capture in between.
  function persistReadSet(entry: RegistryEntry): string[] {
    const last = opts.lastReadSet?.(entry.key);
    return last !== undefined && last.length > 0
      ? last
      : floorGuardTables(entry);
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
  // `sink`, when given, receives the loader's raw return (before the parse) —
  // set synchronously before the parsed value resolves, so a caller reads it
  // right after its await with no extra hop.
  function timedLoad(
    entry: RegistryEntry,
    params: ResourceParams,
    ctx?: { affectedIds: readonly string[] },
    sink?: { raw: unknown; heldFollows?: boolean },
  ): Promise<unknown> {
    const bracket = loadBracket(entry, params);
    const held = heldFollowsFor(entry, paramsKey(params));
    const loadRun: LoadRun | undefined =
      held === undefined
        ? bracket?.run
        : { noteLoaded: bracket?.run.noteLoaded ?? (() => {}), follows: held };
    const run = async () => {
      const raw = await declaredLoad(entry, params, ctx, loadRun);
      if (sink) {
        sink.raw = raw;
        // The value read followed rows it did not read itself: its flight's
        // watermark cannot vouch for them (`getResourceValue`).
        if (held?.servedHeld === true) sink.heldFollows = true;
      }
      return entry.schema.parse(raw);
    };
    let load: Promise<unknown>;
    // This run's own capture, once its span closed (see `RunCapture`).
    let own: RunReads | undefined;
    try {
      if (opts.wrapLoad) {
        const info: LoadInfo = {};
        if (Object.keys(params).length > 0) info.variant = paramsKey(params);
        if (ctx) info.scopedIds = ctx.affectedIds.length;
        load = opts.wrapLoad(entry.key, info, run, (tables, tags) => {
          own = { tables: [...tables].sort(), tags };
        });
      } else {
        load = run();
      }
    } catch (err) {
      // A synchronous throw settles like a rejected load (the bracket's
      // loading count must come down).
      load = Promise.reject(err);
    }
    const judged = driftGuarded(entry)
      ? load.then((value) => checkRouteDrift(entry, own)(value))
      : load;
    return bracket === null ? judged : bracket.settle(judged);
  }

  // The tracked tuple's held follows (`HeldFollows`), one per read (its
  // `servedHeld` says whether any follow was answered from a read it did not
  // start), or undefined: the entry has no follow route, nobody tracks the
  // tuple (nothing would drop a held read — an untracked read reads fresh), or
  // the entry is L2-persisted (its row's floor is the flight's own watermark,
  // which held rows read before it cannot honour).
  function heldFollowsFor(
    entry: RegistryEntry,
    pk: string,
  ): (HeldFollows & { readonly servedHeld: boolean }) | undefined {
    const routing = entry.routing;
    if (routing === undefined || routing.via.size === 0) return undefined;
    if (!entry.tracked.has(pk) || isPersisted(entry)) return undefined;
    let state = routing.followHeld.get(pk);
    if (state === undefined) {
      state = { reads: new Map() };
      routing.followHeld.set(pk, state);
    }
    const own = state;
    const out = {
      servedHeld: false,
      read(
        name: string,
        tuple: string,
        fresh: () => Promise<readonly unknown[]>,
      ): Promise<readonly unknown[]> {
        // The span this state was made in ended (N→0): read, hold nothing.
        if (routing.followHeld.get(pk) !== own) return fresh();
        const known = own.reads.get(name);
        if (known !== undefined && known.tuple === tuple) {
          out.servedHeld = true;
          followHeldHits.set(
            entry.key,
            (followHeldHits.get(entry.key) ?? 0) + 1,
          );
          return known.rows;
        }
        const rows = fresh();
        own.reads.set(name, { tuple, rows });
        // A failed read is held by no one; the caller handles the rejection.
        void rows.then(undefined, () => {
          if (own.reads.get(name)?.rows === rows) own.reads.delete(name);
        });
        return rows;
      },
    };
    return out;
  }

  // A load of an entry with loaded follow routes (`RouteVia.loaded`): the
  // tuple counts as loading from before the loader's first read until it
  // settles — `usesFor` routes its loaded routes past their match meanwhile,
  // since the load may be naming rows a change it would otherwise skip
  // already touched. A load that completes installs what it noted, unless a
  // load started after it already did (its read is newer). One that fails, or
  // completes noting nothing, DROPS the note (same newer-load rule): a change
  // routed during it may have moved what the tuple reads, and a stale note
  // would skip a write to a row it now names — open routes cannot.
  let loadSeq = 0;
  function loadBracket(
    entry: RegistryEntry,
    params: ResourceParams,
  ): { run: LoadRun; settle<V>(load: Promise<V>): Promise<V> } | null {
    const routing = entry.routing;
    if (routing === undefined || routing.loadedRoutes.size === 0) return null;
    const pk = paramsKey(params);
    const seq = ++loadSeq;
    routing.loading.set(pk, (routing.loading.get(pk) ?? 0) + 1);
    let noted: { state: unknown } | undefined;
    const done = () => {
      const left = (routing.loading.get(pk) ?? 1) - 1;
      if (left > 0) routing.loading.set(pk, left);
      else routing.loading.delete(pk);
    };
    return {
      run: {
        noteLoaded(state) {
          noted = { state };
        },
      },
      settle: (load) => {
        const land = (ok: boolean) => {
          const prev = routing.loaded.get(pk);
          // Only a tracked tuple keeps a note: an untracked read (HTTP, a
          // preload) of a tuple nobody holds has nothing to route.
          if (entry.tracked.has(pk) && (prev === undefined || prev.seq < seq)) {
            if (ok && noted !== undefined) {
              routing.loaded.set(pk, { seq, state: noted.state });
            } else {
              routing.loaded.delete(pk);
            }
            routing.uses.delete(pk);
          }
          done();
        };
        return load.then(
          (value) => {
            land(true);
            return value;
          },
          (err: unknown) => {
            land(false);
            throw err;
          },
        );
      },
    };
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
    run?: LoadRun,
  ): Promise<unknown> {
    try {
      return await (run === undefined
        ? entry.loader(params, ctx)
        : entry.loader(params, ctx, run));
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
  // must be covered by its declaration (`readCovered`): its route tables, its
  // derived reads (A22: a rollup no route may name (A1), whose every source the
  // plan routes — `mintRoutePlan` asserted it — so a write moving its rows
  // reaches the entry), its unfed tables, its relation reads, or a relation
  // already found drifted — a tagged route table (`TaggedRead`) only through
  // reads carrying its tag (`lastReadTags`). A miss is reported once per table — or thrown,
  // under `strictRoutes` (tests). In a running server it also FAILS OPEN
  // (`failOpenDrift`): the relation's bases (a table is its own; a view or
  // rollup the tables that feed it — the capture records relations, a change
  // names only base tables) join the router's index for this entry, and every
  // later change to one recomputes every target FULL (`routeEntryChange`), so a
  // plan missing a relation is never staler than a whole-table read of it.
  //
  // D5 — the undeclared-read guard: the same check arms EAGERLY on every
  // external entry that claims to be told of its changes (`driftGuarded`),
  // whether or not it declared reads. An external is reached only by its own
  // notify and its declared reads, so a captured relation it did not declare is
  // a write it never sees — loud (reported, `_debug.routeDrifted`), thrown
  // under `strictRoutes`, and failed open: the entry gets a drift-only routing
  // record (`NO_ROUTES`) if it had none, so a non-keyed one recomputes FULL and
  // a keyed window / point set re-reads the tuple whole (`drainMembershipFull`).
  //
  // With no capture wired (central, the DB-free harness) the guard is off;
  // routing never depends on it.
  function driftGuarded(entry: RegistryEntry): boolean {
    if (!opts.lastReadSet) return false;
    if (entry.routing) return true;
    return guardedExternal(entry);
  }

  // An external that claims a push (`notified`, or no declared freshness — a
  // resource not served through `network/live`): a snapshot, fixed or
  // immutable external is never told of a change by declaration, so an
  // undeclared read there misses nothing it promised to see. A deferred
  // placeholder is judged once bound.
  function guardedExternal(entry: RegistryEntry): boolean {
    return (
      entry.externalSource === true &&
      !deferred.has(entry.key) &&
      (entry.freshness === undefined || entry.freshness.kind === "notified")
    );
  }

  // Whether the per-pk version counter is this entry's COMPLETE change signal
  // within a tracking span — what the same-boot version short-circuit trusts.
  // True for every resource without a `revalidate` signature (each change routes
  // through flushNotifies, which bumps it), and for one declared `notified`:
  // the declaration says every change is told by `notify`, which bumps it too.
  // Only an undeclared revalidatable resource (truth outside any notify stream,
  // e.g. git) keeps its ETag as the authority on every replay.
  function versionIsComplete(entry: RegistryEntry): boolean {
    return !entry.revalidate || entry.freshness?.kind === "notified";
  }

  // Whether a flight of this entry may read Postgres — so whether its commit
  // watermark describes anything. A guarded external with no routing record
  // reads none while the D5 drift guard is armed (a read capture is wired): a
  // captured read would have given it a drift-only record (`failOpenDrift`).
  // With no capture wired nothing proves it, so it captures as before. A
  // DB-free flight captures no watermark: an xmin round trip inside a
  // read-admission slot for a value no transaction is reflected in (every
  // `config-v2.values` tuple of a post-boot replay paid one). Shipping no
  // watermark is the safe direction — "no causal floor"
  // forbids a denial, never a confirmation by content — and an external is
  // never L2-persisted, so no floor is lost there. A `readCost: "memory"`
  // entry reads no Postgres by its declaration: no capture either (it would
  // be the one round trip of a slotless read).
  //
  // An external also reads Postgres only when its LOADER does — derived from
  // what its last run read (the per-run capture), not from a flag: a reach
  // plan routes a change to it, but says nothing about what the loader reads
  // (`conversations.partial-message` declares a lookup its `whileSubscribed`
  // reads once and answers every push from memory — each 50 ms push used to
  // pay an xmin round trip). A run that read nothing ⇒ no capture. Predicting
  // from the previous run is safe in both directions: a loader that starts
  // reading ships one frame with no floor (the safe direction above), and its
  // capture arms the next flight.
  function readsDb(entry: RegistryEntry): boolean {
    if (entry.readCost === "memory") return false;
    if (entry.externalSource === true && opts.lastReadSet !== undefined) {
      const last = opts.lastReadSet(entry.key);
      if (last !== undefined && last.length === 0) return false;
    }
    return !(
      opts.lastReadSet !== undefined &&
      guardedExternal(entry) &&
      !entry.routing
    );
  }

  // One xmin capture shared by every flight that asks while it is in flight.
  // Sound by `captureWatermark`'s own contract: the shared capture resolves
  // before the joining flight's loader starts, so it was taken before that
  // flight's first read — a valid floor, at worst OLDER than a capture of its
  // own (an older floor only over-replays at catch-up and confirms less). A
  // replay herd of N cold flights then costs one round trip per wave, not N.
  // Sharing must not couple failures: a flight joins only a capture started
  // within `WATERMARK_SHARE_MS` (a hung one is superseded, never waited on by
  // every later read), and a joiner whose shared capture failed captures its
  // own — the starter's error is the starter's.
  const watermarkFlight = createInflight();
  async function captureSharedWatermark(
    capture: () => Promise<string>,
  ): Promise<string> {
    let started = false;
    const shared = watermarkFlight.run(
      "watermark",
      () => {
        started = true;
        return capture();
      },
      { notBefore: performance.now() - WATERMARK_SHARE_MS },
    );
    try {
      return await shared;
    } catch (err) {
      if (started) throw err;
      return capture();
    }
  }

  // Whether a captured `relation` is one the entry's declaration covers — the
  // ONE predicate the drift guard (A8 / D5) and the boot drift seed
  // (`seedRouteDrift`) judge by: routes ∪ derived ∪ unfed ∪ relation reads ∪
  // already drifted. A followed table (`Route.via`) is never covered by the
  // entry's own capture. A tagged route table (`TaggedRead`) is covered only when
  // every read of it carried one of its tags — judged from the run's `tags`;
  // `"untracked"` (a persisted `tables_read`, which records no tags) judges
  // it by its name alone, as a route table.
  function readCovered(
    routing: RoutingRecord | undefined,
    relation: string,
    tags: ReadTags | undefined | "untracked",
  ): boolean {
    if (routing === undefined) return false;
    if (routing.drifted.has(relation)) return true;
    // A followed table is read through its collection's own read, in that
    // collection's loader span — never in this entry's: a capture of it
    // here is a read by hand, which no route gates. A persisted
    // `tables_read` ("untracked") cannot tell the spans apart — it may hold
    // the route tables themselves (`persistReadSet`'s fallback) —, so the
    // seed judges a followed table by its name, as a route table.
    if (routing.via.has(relation) && tags !== "untracked") return false;
    const only = routing.tagged.get(relation);
    if (only !== undefined && tags !== "untracked") {
      const seen = tags?.get(relation);
      return (
        seen !== undefined &&
        [...seen].every((tag) => tag !== null && only.has(tag))
      );
    }
    return (
      routing.byTable.has(relation) ||
      routing.derived.has(relation) ||
      routing.unfed.has(relation) ||
      routing.relations.has(relation) ||
      routing.notified.has(relation)
    );
  }

  function checkRouteDrift(
    entry: RegistryEntry,
    own: RunReads | undefined,
  ): (value: unknown) => unknown {
    return (value) => {
      // The run's own capture; a host that hands none (a test harness) is
      // read per key, its reads stated for the key.
      const captured = own?.tables ?? opts.lastReadSet!(entry.key) ?? [];
      const tags =
        own !== undefined ? own.tags : opts.lastReadTags?.(entry.key);
      dropUnreadSeeds(entry, captured);
      const unrouted = captured.filter(
        (table) => !readCovered(entry.routing, table, tags),
      );
      if (unrouted.length === 0) return value;
      const tables = unrouted.map((t) => `"${t}"`).join(", ");
      const outsideTag = unrouted.filter((t) => entry.routing?.tagged.has(t));
      const byHand = unrouted.filter((t) => entry.routing?.via.has(t));
      const err = new ResourceGuardError(
        "RouteDrift",
        entry.key,
        byHand.length > 0
          ? `resource "${entry.key}" read ${byHand.map((t) => `"${t}"`).join(", ")} by hand, which it follows (${byHand.map((t) => `"${t}": ${namedFollows(entry.routing!.via.get(t)!)}`).join("; ")}) — the follow's routes gate and match only what that collection reads, so a write reaching this read would be missed. Read it through \`followed\`.`
          : outsideTag.length > 0
            ? `resource "${entry.key}" read ${outsideTag.map((t) => `"${t}"`).join(", ")} outside the tagged queries that cover it (${outsideTag.map((t) => `"${t}": ${[...entry.routing!.tagged.get(t)!].map((tag) => `"${tag}"`).join(" | ")}`).join("; ")}) — its route's columns gate only what those queries read, so a write to another column would never reach it. Read the table through that lookup, or declare it whole.`
            : entry.routing && entry.routing.plan !== NO_ROUTES
              ? `routed resource "${entry.key}" read ${tables}, which none of its routes names — a write there never reaches it. Its compiler must emit a route for every table the SQL reads.`
              : `external resource "${entry.key}" read ${tables}, which it does not declare — a write there never reaches it (only its own notify does). Declare the value's reads, or its freshness if it is never told of a change.`,
      );
      if (opts.strictRoutes) throw err;
      failOpenDrift(entry, unrouted);
      reportLoaderError(`route drift for ${entry.key}`, err);
      return value;
    };
  }

  // The fail-open half of the drift guard: each uncovered relation is recorded
  // as drifted, and its bases are indexed for the router as a FULL read of the
  // entry — a tagged route table included: its gated route no longer decides
  // (`routeEntryChange` reads `driftBases` first). A guarded external with no
  // routing gets a drift-only record first.
  function failOpenDrift(
    entry: RegistryEntry,
    relations: readonly string[],
  ): void {
    entry.routing ??= driftOnlyRouting();
    const routing = entry.routing;
    for (const relation of relations) {
      routing.drifted.add(relation);
      routing.seededDrift.delete(relation);
      indexDriftBases(routing, entry, relation);
    }
  }

  // D7's other half: a relation seeded from a persisted `tables_read` that
  // this load did not read is judged — it no longer reads it, so its bases
  // stop routing FULL to the entry (a base a drifted or still-seeded relation,
  // a relation read or a route also needs stays). One it did read is judged
  // by the guard below (reported, moved to `drifted`).
  function dropUnreadSeeds(
    entry: RegistryEntry,
    captured: readonly string[],
  ): void {
    const routing = entry.routing;
    if (!routing || routing.seededDrift.size === 0) return;
    const read = new Set(captured);
    let dropped = false;
    for (const relation of routing.seededDrift) {
      if (read.has(relation)) continue;
      routing.seededDrift.delete(relation);
      dropped = true;
    }
    if (!dropped) return;
    const needed = new Set<string>();
    for (const relation of [...routing.drifted, ...routing.seededDrift]) {
      for (const base of driftBasesOf(relation)) needed.add(base);
    }
    for (const base of routing.driftBases) {
      if (needed.has(base)) continue;
      routing.driftBases.delete(base);
      if (!routing.relationBases.has(base) && !routing.byTable.has(base)) {
        unindexTable(base, entry);
      }
    }
  }

  // Index `relation`'s bases for the router as a FULL read of the entry.
  function indexDriftBases(
    routing: RoutingRecord,
    entry: RegistryEntry,
    relation: string,
  ): void {
    for (const base of driftBasesOf(relation)) {
      // A route table is reached through its route — unless the route is
      // tagged, or a follow's: a read outside its tag, or by hand beside a
      // follow, may read any column of any row, so it goes FULL.
      if (
        routing.byTable.has(base) &&
        !routing.tagged.has(base) &&
        !routing.via.has(base)
      ) {
        continue;
      }
      routing.driftBases.add(base);
      if (!indexedUnder(base, entry)) indexTable(base, entry);
    }
  }

  // A routing record that routes nothing — the drift guard's own, for a guarded
  // external that declared no reads (D5). Every table it is indexed under is a
  // drifted relation's base, served FULL by `routeEntryChange`.
  function driftOnlyRouting(
    unfed: ReadonlySet<string> = new Set(),
  ): RoutingRecord {
    return {
      plan: NO_ROUTES,
      byTable: new Map(),
      routeIds: new Set(),
      matchOf: new Map(),
      derived: new Set(),
      unfed,
      relations: new Map(),
      notified: new Map(),
      tagged: new Map(),
      via: new Map(),
      drifted: new Set(),
      relationBases: new Set(),
      driftBases: new Set(),
      seededDrift: new Set(),
      uses: new Map(),
      loadedRoutes: new Set(),
      loaded: new Map(),
      loading: new Map(),
      followHeld: new Map(),
    };
  }

  /**
   * D7 — drift survives a restart: judge each persisted entry's durable
   * `tables_read` (the last FULL run's capture) by the same predicate the
   * drift guard uses, and fail open on every relation the declaration does
   * not cover — its bases routed FULL, as a drifted read's are — so a write
   * there while nothing has loaded yet still reaches the entry. A rollup or
   * view the plan declares (derived / relation reads) is covered, not drift.
   * Not reported, and not counted as covered (`seededDrift`): the row may
   * predate a declaration change, or carry an edge the code no longer reads,
   * so the next load judges each one afresh — reports it, once, if it still
   * reads it, and un-routes it if not (`dropUnreadSeeds`). An entry with no routing (not routed) is skipped.
   * Returns what it seeded.
   */
  function seedRouteDrift(
    persisted: ReadonlyArray<{ key: string; tablesRead: readonly string[] }>,
  ): Array<{ key: string; tables: string[] }> {
    const seeded: Array<{ key: string; tables: string[] }> = [];
    for (const { key, tablesRead } of persisted) {
      const entry = registry.get(key);
      const routing = entry?.routing;
      if (!entry || !routing) continue;
      const tables = [...new Set(tablesRead)].filter(
        (table) => !readCovered(routing, table, "untracked"),
      );
      if (tables.length === 0) continue;
      for (const table of tables) {
        routing.seededDrift.add(table);
        indexDriftBases(routing, entry, table);
      }
      seeded.push({ key, tables });
    }
    return seeded;
  }

  // The bases a drifted relation fails open on. Server-core's bases holder
  // throws until change-feed installs the graph (boot): a load drifting before
  // then fails open on the relation's own name and says why, rather than not
  // at all.
  function driftBasesOf(relation: string): readonly string[] {
    try {
      return relationBasesOf(relation);
    } catch (err) {
      reportLoaderError(
        `route drift: relation bases unknown for "${relation}"`,
        err,
      );
      return [relation];
    }
  }

  function indexedUnder(table: string, entry: RegistryEntry): boolean {
    return routedByTable.get(table)?.includes(entry) ?? false;
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
    gated?: GatedReader,
    seedAckTx?: readonly string[],
    notBefore?: number,
  ): Promise<FlightValue> {
    if (ctx) {
      // A scoped load bypasses the inflight entirely, so it can never join
      // anything and `notBefore` has nothing to refuse — ignored, not forgotten.
      const sink = { raw: undefined as unknown };
      return {
        value: await timedLoad(entry, params, ctx, sink),
        raw: sink.raw,
        etag: undefined,
        watermark: undefined,
        ackTx: seedAckTx,
      };
    }
    // Gate-after-dedup: when `gated` (the read path), the read-admission slot is
    // acquired INSIDE the single-flight factory, so only the STARTER of a flight
    // ever occupies a slot — N replayed subs of one (key, params) consume 1 slot,
    // not N (the "joiners burn read-admit slots" convoy of
    // research/perfs/2026-07-11-compressor-thrash-subscription-replay-storm.md
    // Finding 3). Joiners ride the EXISTING `read-coalesce` wait
    // (`onCoalesceJoin`), which now subsumes the flight's gate wait: a coalesced
    // caller's reported wait includes the starter's time queueing for a slot,
    // charged as coalesce-wait in the joiner's own context — never gate-wait
    // (only the starter reports `readGateWait`, in its own context, because
    // inflight runs the starter's factory synchronously in its call frame).
    // Push-path callers (`gated` undefined) start UNGATED flights exactly as before;
    // a gated read joining one rides the coalesce wait with no slot either way.
    // The flight factory: watermark capture FIRST (Rule B — the floor is valid
    // only if captured before the loader's first read), then the loader. Runs
    // only in the STARTER's frame; joiners coalesce onto the resolved object.
    const load = async (): Promise<FlightValue> => {
      let watermark: string | undefined;
      if (opts.captureWatermark && readsDb(entry)) {
        try {
          watermark = await captureSharedWatermark(opts.captureWatermark);
        } catch (err) {
          // Tokenless degrade — the value still ships; the client just cannot
          // causally deny against this frame. Loud via the report hook.
          reportLoaderError(`watermark capture failed for ${entry.key}`, err);
        }
      }
      // `ackTx: seedAckTx` — the STARTER's seed; joiners adopt it wholesale
      // (like the etag/watermark), so a stamped ackTx always describes the
      // flight that produced the value it rides with.
      const sink: { raw: unknown; heldFollows?: boolean } = {
        raw: undefined,
      };
      const value = await timedLoad(entry, params, undefined, sink);
      return {
        value,
        raw: sink.raw,
        etag: seedEtag,
        // A value built on held followed rows (`HeldFollows`) ships no causal
        // floor: a commit before this capture may have moved them with its
        // change not routed yet — the safe direction (no floor forbids a
        // denial, never a confirmation). The routed change recomputes it.
        watermark: sink.heldFollows === true ? undefined : watermark,
        ackTx: seedAckTx,
      };
    };
    const pk = paramsKey(params);
    const flightKey = flightKeyOf(entry.key, pk);
    // A tuple's subscription is wanted while the tuple is tracked; every other
    // caller (an HTTP read, a push drain) is counted on the flight until it
    // settles. Counted on the side, so the promise handed back is the flight's
    // own (no extra hop before a continuation: H5's ordering).
    const untracked = gated !== "sub";
    if (untracked) {
      untrackedFlightReaders.set(
        flightKey,
        (untrackedFlightReaders.get(flightKey) ?? 0) + 1,
      );
    }
    const batch = gated ? pointBatchOf(entry) : undefined;
    const flight = inflight.run(
      flightKey,
      gated
        ? (inFlight) => {
            const wanted = () => {
              if (readWanted(entry, pk)) return true;
              // Giving up: no caller arriving from now on may join and
              // inherit the `ReadAbandoned` — it starts a fresh read.
              inFlight.detach();
              return false;
            };
            return batch !== undefined
              ? readPointBatched(entry, batch, {
                  params,
                  pk,
                  wanted,
                  seedEtag,
                  seedAckTx,
                })
              : admitRead(entry, { pk, probe: false }, wanted, load);
          }
        : load,
      {
        onJoin: opts.onCoalesceJoin,
        // Undefined for every read caller ⇒ join any live flight, exactly as
        // before. Set only by the FULL drains, which cannot serve a value older
        // than the notify they are minting a version for.
        notBefore,
        onSupersede: () => recordStaleFlightSupersede(entry.key),
      },
    );
    if (untracked) {
      const settle = () => {
        const n = (untrackedFlightReaders.get(flightKey) ?? 1) - 1;
        if (n > 0) untrackedFlightReaders.set(flightKey, n);
        else untrackedFlightReaders.delete(flightKey);
      };
      // The caller handles the flight's own rejection; this branch only counts.
      void flight.then(settle, settle);
    }
    return flight;
  }

  // Admit one read-path body: a slot of the read-admission gate, within its
  // key's share (`READ_KEY_SHARE`), yieldable, labelled for `holders` and
  // charged as `read-admit`. `wanted` is asked when the slot comes; a read
  // nobody is owed any more rejects with `ReadAbandoned` instead of running
  // (see `readWanted`). A `readCost: "memory"` entry's read runs at once, with
  // no slot: it has no I/O for the gate to bound, and queueing it FIFO behind
  // reads that do would make the cheapest read as slow as the slowest. Timed,
  // so a declaration its reads do not keep is reported (`checkMemoryRead`).
  function admitRead<T>(
    entry: RegistryEntry,
    read: { pk: string; probe: boolean },
    wanted: () => boolean,
    body: () => Promise<T>,
  ): Promise<T> {
    const key = entry.key;
    const label = `${read.probe ? "revalidate " : ""}${gateLabel(key, read.pk)}`;
    if (entry.readCost === "memory") {
      if (!wanted()) return Promise.reject(new ReadAbandoned(key));
      const t0 = performance.now();
      const tuple = `${read.probe ? "probe" : "load"}\0${read.pk}`;
      const warm = memoryReadWarm(key, tuple);
      const settled = () =>
        settleMemoryRead(key, tuple, warm, label, performance.now() - t0);
      const run = body();
      // Observes only — the caller handles the read's own rejection.
      void run.then(settled, settled);
      return run;
    }
    return readLoadGate.run(
      () => {
        if (!wanted()) throw new ReadAbandoned(key);
        return body();
      },
      {
        onWait: opts.readGateWait?.onWait,
        onQueued: opts.readGateWait?.onQueued,
        yieldable: true,
        label,
        class: key,
      },
    );
  }

  // The point batch a gated read of `entry` may join (`PointBatch`), or
  // undefined: the entry declares none, or something about it makes a load
  // more than "the rows of these ids" — a value read through follows or
  // noted per load (its held state is per tuple), a `revalidate` signature
  // (its ETag describes one tuple's value), bytes, an external source, a
  // memory read (it takes no slot to share).
  function pointBatchOf(entry: RegistryEntry): PointBatch | undefined {
    const membership = entry.membership;
    if (membership?.kind !== "point" || membership.batch === undefined) {
      return undefined;
    }
    const routing = entry.routing;
    if (
      routing === undefined ||
      routing.via.size > 0 ||
      routing.loadedRoutes.size > 0 ||
      entry.externalSource === true ||
      entry.revalidate !== undefined ||
      entry.bytes === true ||
      entry.readCost === "memory"
    ) {
      return undefined;
    }
    return membership.batch;
  }

  // The point batches still waiting for their read-admission slot, one open
  // per (key, family): a read of the family joins it until the slot comes
  // (or it is full), then the next read opens another. See `PointBatch`.
  interface PointBatchMember {
    params: ResourceParams;
    pk: string;
    ids: readonly string[];
    /** Asked once, when the slot comes (`readWanted`, detaching on false). */
    wanted: () => boolean;
    seedEtag: string | undefined;
    seedAckTx: readonly string[] | undefined;
    resolve: (value: FlightValue) => void;
    reject: (err: unknown) => void;
  }
  interface OpenPointBatch {
    ids: Set<string>;
    members: PointBatchMember[];
  }
  const openPointBatches = new Map<string, OpenPointBatch>();
  const pointBatchStats = new Map<string, { runs: number; joined: number }>();

  // One tuple's cold read through its family's batch: joins the open one when
  // its ids fit (`maxIds`), else opens one and queues it for a slot. The
  // promise is the flight's own (no hop added); a joiner's wait is charged as
  // `read-coalesce` in its own context, like a joined flight's.
  function readPointBatched(
    entry: RegistryEntry,
    batch: PointBatch,
    read: Omit<PointBatchMember, "ids" | "resolve" | "reject">,
  ): Promise<FlightValue> {
    const membership = entry.membership as Extract<
      MembershipRecord,
      { kind: "point" }
    >;
    let ids: readonly string[];
    let slot: string;
    try {
      ids = membership.idsOf(read.params);
      slot = `${entry.key}\u0000${batch.familyOf(read.params)}`;
    } catch (err) {
      return Promise.reject(err);
    }
    let open = openPointBatches.get(slot);
    if (open !== undefined) {
      let union = open.ids.size;
      for (const id of new Set(ids)) if (!open.ids.has(id)) union++;
      if (union > batch.maxIds) open = undefined;
    }
    const joining = open !== undefined;
    const target = open ?? { ids: new Set<string>(), members: [] };
    const value = new Promise<FlightValue>((resolve, reject) => {
      target.members.push({ ...read, ids, resolve, reject });
    });
    for (const id of ids) target.ids.add(id);
    if (joining) {
      const stats = pointBatchStatsOf(entry.key);
      stats.joined++;
      // Announced now, charged as the batch settles: the joiner waits on
      // another read's batch, never on its own work.
      const end = opts.onCoalesceJoin?.();
      // Observes only — the flight's caller handles the rejection.
      if (end) void value.then(end, end);
    } else {
      openPointBatches.set(slot, target);
      startPointBatch(entry, batch, slot, target, read.pk);
    }
    return value;
  }

  function pointBatchStatsOf(key: string): { runs: number; joined: number } {
    let stats = pointBatchStats.get(key);
    if (stats === undefined) {
      stats = { runs: 0, joined: 0 };
      pointBatchStats.set(key, stats);
    }
    return stats;
  }

  // Queue an opened batch for its slot. When the slot comes the batch closes
  // (a later read opens the next one), every member nobody is owed any more
  // is dropped (`ReadAbandoned`, as a lone read is), and the rest load as one.
  function startPointBatch(
    entry: RegistryEntry,
    point: PointBatch,
    slot: string,
    batch: OpenPointBatch,
    firstPk: string,
  ): void {
    const wanted = () => {
      if (openPointBatches.get(slot) === batch) openPointBatches.delete(slot);
      const live: PointBatchMember[] = [];
      for (const m of batch.members) {
        if (m.wanted()) live.push(m);
        else m.reject(new ReadAbandoned(entry.key));
      }
      batch.members = live;
      return live.length > 0;
    };
    // A rejection the members did not see yet (the loader's, the gate's)
    // settles every one; a settled member ignores it.
    void admitRead(entry, { pk: firstPk, probe: false }, wanted, () =>
      runPointBatch(entry, point, batch.members),
    ).then(undefined, (err: unknown) => {
      if (openPointBatches.get(slot) === batch) openPointBatches.delete(slot);
      for (const m of batch.members) m.reject(err);
    });
  }

  // The batch's one load, in its slot: the watermark first (Rule B — captured
  // before the loader's first read, so it is a valid floor for every member),
  // then the loader. A lone member loads exactly as an unbatched read does;
  // several load the union of their ids as a scoped read, each served its own
  // ids' rows in the loader's order.
  async function runPointBatch(
    entry: RegistryEntry,
    point: PointBatch,
    members: readonly PointBatchMember[],
  ): Promise<void> {
    pointBatchStatsOf(entry.key).runs++;
    let watermark: string | undefined;
    if (opts.captureWatermark && readsDb(entry)) {
      try {
        watermark = await captureSharedWatermark(opts.captureWatermark);
      } catch (err) {
        // Tokenless degrade, as `getResourceValue`'s flight.
        reportLoaderError(`watermark capture failed for ${entry.key}`, err);
      }
    }
    const first = members[0]!;
    const sink: { raw: unknown; heldFollows?: boolean } = { raw: undefined };
    if (members.length === 1) {
      const value = await timedLoad(entry, first.params, undefined, sink);
      first.resolve({
        value,
        raw: sink.raw,
        etag: first.seedEtag,
        watermark: sink.heldFollows === true ? undefined : watermark,
        ackTx: first.seedAckTx,
      });
      return;
    }
    const union = new Set<string>();
    for (const m of members) for (const id of m.ids) union.add(id);
    const rows = await timedLoad(
      entry,
      first.params,
      { affectedIds: [...union] },
      sink,
    );
    if (!Array.isArray(rows)) {
      throw new Error(
        `keyed resource "${entry.key}" loader must return an array`,
      );
    }
    const keyOf = entry.keyOf!;
    const byId = new Map<string, number[]>();
    members.forEach((m, i) => {
      for (const id of new Set(m.ids)) {
        const at = byId.get(id);
        if (at === undefined) byId.set(id, [i]);
        else at.push(i);
      }
    });
    const served: unknown[][] = members.map(() => []);
    const found = new Set<string>();
    for (const row of rows as unknown[]) {
      const id = keyOf(row);
      found.add(id);
      for (const i of byId.get(id) ?? []) served[i]!.push(row);
    }
    for (const [i, m] of members.entries()) {
      // An id that named no row is absent when the loader matches it under
      // its own spelling alone (`exactId`): the batch's read already
      // answered it. Otherwise the database may match it under another
      // spelling than the row's key (a uuid in upper case) — which only the
      // member's own read can tell apart — so that member is read alone, in
      // this slot. A herd of per-row tuples mostly names rows that do not
      // exist (a chip per conversation reading a side table most have no row
      // in): each such id re-read alone held the slot for one query per
      // member, one after another (2026-11-12 restart storm: 21–44 lone
      // re-reads of conversation-preprompts per restart, up to 1.3 s).
      if (m.ids.some((id) => !found.has(id) && !point.exactId(id))) {
        const own: { raw: unknown; heldFollows?: boolean } = { raw: undefined };
        const value = await timedLoad(entry, m.params, undefined, own);
        m.resolve({
          value,
          raw: own.raw,
          etag: m.seedEtag,
          watermark: own.heldFollows === true ? undefined : watermark,
          ackTx: m.seedAckTx,
        });
        continue;
      }
      const value = served[i]!;
      m.resolve({
        value,
        // `raw` serves D8's identity fast path, for a `revalidate` entry
        // only — which never batches (`pointBatchOf`).
        raw: value,
        etag: m.seedEtag,
        watermark: sink.heldFollows === true ? undefined : watermark,
        ackTx: m.seedAckTx,
      });
    }
  }

  // A `readCost: "memory"` read of a WARM tuple slower than
  // `MEMORY_READ_BUDGET_MS` breaks its declaration: it did I/O (or waited on
  // it) without a slot. A tuple — its load and its `revalidate` probe apart —
  // is warm once one of its reads has completed in this process; a read that
  // starts before then is exempt, as it may be (or wait on) the one cold
  // build of the memo the declaration names (a sprite set parsed once, the
  // config registry coming up). So the check catches a loader that does I/O
  // on every read, never a memo warming. Reported loudly, once per key per
  // process: the fix is the declaration (or the memo it claims), never a
  // bigger budget. Only `"memory"` keys are tracked, a key stops being
  // tracked once reported, and a key's warm set is bounded (past
  // `MEMORY_READ_WARM_MAX` it starts over, every tuple cold again).
  const memoryReadsWarm = new Map<string, Set<string> | null>();
  function memoryReadWarm(key: string, tuple: string): boolean {
    return memoryReadsWarm.get(key)?.has(tuple) === true;
  }
  function settleMemoryRead(
    key: string,
    tuple: string,
    warm: boolean,
    label: string,
    ms: number,
  ): void {
    let seen = memoryReadsWarm.get(key);
    if (seen === null) return;
    if (warm && ms > MEMORY_READ_BUDGET_MS) {
      memoryReadsWarm.set(key, null);
      reportLoaderError(
        `"${key}" is declared readCost "memory" but a read (${label}) took ${Math.round(ms)}ms`,
        new Error(
          `A readCost "memory" read takes no read-admission slot, so it must answer from memory held by this process (budget ${MEMORY_READ_BUDGET_MS}ms). Drop the declaration if its reads do I/O.`,
        ),
      );
      return;
    }
    if (seen === undefined || seen.size >= MEMORY_READ_WARM_MAX) {
      memoryReadsWarm.set(key, (seen = new Set()));
    }
    seen.add(tuple);
  }

  // Is a read of (entry, pk) still owed to anyone? A subscription is owed
  // while its tuple is tracked (any socket, a lingering one included); every
  // other caller is counted on the flight. Asked when a queued read reaches
  // its slot — the moment a read nobody waits for would start costing.
  function readWanted(entry: RegistryEntry, pk: string): boolean {
    return (
      entry.tracked.has(pk) ||
      (untrackedFlightReaders.get(flightKeyOf(entry.key, pk)) ?? 0) > 0
    );
  }

  function recordAbandonedRead(key: string): void {
    abandonedReads.set(key, (abandonedReads.get(key) ?? 0) + 1);
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
  //
  // `reader` says who asks: a tuple's subscription (`sub`) is dropped at the
  // gate once nobody holds the tuple — it rejects with `ReadAbandoned`, which
  // its caller answers by sending nothing.
  function gatedRead(
    entry: RegistryEntry,
    params: ResourceParams,
    reader: GatedReader,
    seedEtag?: string,
    onJoined?: (joinedMs: number) => void,
  ): Promise<FlightValue> {
    // No ackTx seed and the resolved ackTx is discarded: read-path frames
    // (sub-ack / HTTP body) never carry one — their snapshot watermark subsumes
    // it (Rule B).
    const run = () =>
      getResourceValue(entry, params, undefined, seedEtag, reader);
    return opts.wrapOrigin
      ? opts.wrapOrigin("sub", entry.key, run, onJoined)
      : run();
  }

  // Compute a resource's conditional-revalidation ETag under the SAME gate + `sub`
  // origin as a read-path load (the signature may spawn git/fs). Returns undefined
  // when the resource never opted in OR the signature threw — a fail-safe: the
  // caller then falls through to the full loader / omits the ETag, so a broken
  // signature degrades to today's behavior and never serves stale.
  //
  // A subscription's probe (`reader: "sub"`) is dropped at the gate like its
  // read once nobody holds the tuple: `ReadAbandoned` is rethrown, never
  // reported. An HTTP probe always runs — its caller awaits the answer.
  //
  // Subscription probes of one tuple QUEUED together share one signature read
  // (`queuedProbes`), as its loads share one flight (gate-after-dedup): a
  // restart's replay restates every tuple from every tab, and each probe used
  // to take its own slot to read the same signature — `build.deployment`'s
  // `git rev-parse` eight times per restart, one per tab, queued behind its
  // key's share. Sound because the shared read has not started when a probe
  // joins it: its signature describes the state after the joiner's sub was
  // registered, exactly what the joiner's own probe would have read. A probe
  // already admitted is never joined (it may have read before the joiner
  // registered, and a change in between would answer the joiner `up-to-date`
  // over a value it never received). Subscriptions only: an HTTP probe's
  // caller is not a tracked holder, so it keeps its own read.
  async function computeEtag(
    entry: RegistryEntry,
    params: ResourceParams,
    reader: GatedReader,
  ): Promise<string | undefined> {
    if (!entry.revalidate) return undefined;
    const revalidate = entry.revalidate;
    const pk = paramsKey(params);
    const flightKey = flightKeyOf(entry.key, pk);
    try {
      const queued = reader === "sub" ? queuedProbes.get(flightKey) : undefined;
      let raw: string;
      if (queued !== undefined) {
        sharedProbes.set(entry.key, (sharedProbes.get(entry.key) ?? 0) + 1);
        raw = await queued.read;
      } else {
        // Set once the probe is shareable; the body (run at admission)
        // withdraws it, so no probe joins a read that may have started.
        let shared: QueuedProbe | undefined;
        let admitted = false;
        const run = () =>
          admitRead(
            entry,
            { pk, probe: true },
            () => reader !== "sub" || entry.tracked.has(pk),
            () => {
              admitted = true;
              if (shared && queuedProbes.get(flightKey) === shared)
                queuedProbes.delete(flightKey);
              return revalidate(params, heldFollowsFor(entry, pk));
            },
          );
        const read = opts.wrapOrigin
          ? opts.wrapOrigin("sub", entry.key, run)
          : run();
        // A memory read runs at once, inside `run`: it is admitted already.
        if (reader === "sub" && !admitted) {
          const probe: QueuedProbe = { read };
          shared = probe;
          queuedProbes.set(flightKey, probe);
          const clear = () => {
            if (queuedProbes.get(flightKey) === probe)
              queuedProbes.delete(flightKey);
          };
          // Observes only — every awaiting caller handles the rejection.
          void read.then(clear, clear);
        }
        raw = await read;
      }
      return normalizeEtag(raw);
    } catch (err) {
      if (err instanceof ReadAbandoned) throw err;
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
      const run = () =>
        revalidate(params, heldFollowsFor(entry, paramsKey(params)));
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
  // its own notify → a rerun pass → another drainEntry that ships a fresh value +
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
  // `pending` is the drained notify the frame answers: its `timing` is built
  // from it at send time (`frameTiming`). Synchronous, so H5a holds as well.
  function sendUpdate(
    entry: RegistryEntry,
    params: ResourceParams,
    value: unknown,
    version: number,
    subs: SocketState[],
    watermark?: string,
    ackTx?: readonly string[],
    pending?: PendingNotify,
    patch?: ValuePatch,
  ): number | Promise<number> {
    // A patched entry ships what changed against the value every holder at
    // the base's version holds (`patch`: the drain's own D8 diff — one walk
    // decides both "changed?" and "what changed"); the first frame of a span,
    // and a change of the root itself, ship the whole value. Synchronous: no
    // await before the wire (H5a) — a patched entry has no `revalidate`.
    if (entry.patches && patch !== undefined && patch.ops !== null) {
      return broadcastJson(subs, {
        kind: "patch" as const,
        key: entry.key,
        params,
        base: patch.base,
        version,
        ops: patch.ops,
        ...(watermark !== undefined ? { watermark } : {}),
        ...(ackTx !== undefined && ackTx.length > 0 ? { ackTx } : {}),
        ...(pending !== undefined ? frameTiming(pending) : {}),
      });
    }
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
        // Stamped inside `broadcast`, after any etag await: `sentAt` is the send.
        ...(pending !== undefined ? frameTiming(pending) : {}),
      };
      return broadcastJson(subs, msg);
    };
    if (!entry.revalidate) {
      return broadcast(); // sync send — no microtask before the wire (H5a)
    }
    return pushEtag(entry, params).then(broadcast);
  }

  // D8: whether `entry` keeps the value every holder of a tuple holds
  // (`RegistryEntry.held`), so a non-keyed drain whose recompute equals it
  // sends nothing. Every pushed value — whatever its loader — but a persisted
  // one (read at boot from its L2 row and hydrated into pages through
  // boot-snapshot, with no holder this runtime saw, so "what every holder
  // holds" has no answer) and an `invalidate` one (its frame carries no
  // value, and a drain does not load one to compare). A keyed entry diffs
  // per row instead (`diffKeyed`).
  function holdsValue(entry: RegistryEntry, persisted: boolean): boolean {
    return entry.mode === "push" && !persisted;
  }

  // D8: whether the drain's recompute `value` (from `raw`) changed nothing a
  // holder of the tuple lacks — and, when there is a held value to compare
  // against, the comparison itself (`ops`), so a patched entry's frame reuses
  // the one walk. A memo's own object again is unchanged without a walk
  // (identity is content: a `revalidate` loader's values are a memo's,
  // immutable). Otherwise `diffValue` compares as the JSON the frame would
  // carry: `[]` is unchanged.
  function compareHeld(
    entry: RegistryEntry,
    pk: string,
    value: unknown,
    raw: unknown,
  ): { unchanged: boolean; patch?: ValuePatch } {
    const held = entry.held.get(pk);
    if (held === undefined) return { unchanged: false };
    if (entry.revalidate !== undefined && held.raw === raw)
      return { unchanged: true };
    const ops = diffValue(held.value, value);
    return {
      unchanged: ops !== null && ops.length === 0,
      patch: { base: held.version, ops },
    };
  }

  // D8: a read handed one holder of the tuple something — `served`, the value
  // (and the loader's raw return) it was served from, or `undefined` for
  // anything else (an `up-to-date`, a 304, an error). The held value survives
  // only if the holder now holds equal content (the very raw object for a
  // memo, or `diffValue` → `[]` — the drain's own comparison). `sole`: the
  // read is the sub-ack of the subscription that opened the tuple's span (the
  // global 0→1, which minted the `version` it reports — above any version a
  // client holds, so its holder applies it). While that holder is still the
  // tuple's only one and no drain minted since (`version` still current: no
  // frame reached it after this read), every holder holds `served`, and it
  // becomes the held value — two first reads racing leave none (for a
  // patched entry, a base two holders do not share would corrupt one).
  function noteRead(
    entry: RegistryEntry,
    pk: string,
    served: { value: unknown; raw: unknown } | undefined,
    sole?: { state: SocketState; version: number },
  ): void {
    if (!holdsValue(entry, isPersisted(entry))) return;
    if (
      served !== undefined &&
      sole !== undefined &&
      entry.subCounts.get(pk) === 1 &&
      sole.state.subs.get(entry.key)?.get(pk)?.tabs.size === 1 &&
      entry.versions.get(pk) === sole.version
    ) {
      entry.held.set(
        pk,
        heldValue(entry, sole.version, served.value, served.raw),
      );
      return;
    }
    const held = entry.held.get(pk);
    if (held === undefined) return;
    if (
      served !== undefined &&
      ((entry.revalidate !== undefined && held.raw === served.raw) ||
        diffValue(held.value, served.value)?.length === 0)
    ) {
      return;
    }
    entry.held.delete(pk);
  }

  function heldValue(
    entry: RegistryEntry,
    version: number,
    value: unknown,
    raw: unknown,
  ): HeldValue {
    return entry.revalidate !== undefined
      ? { version, value, raw }
      : { version, value };
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
    heardAt?: number,
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
        ...(changedAt !== undefined && heardAt !== undefined
          ? { heardAt }
          : {}),
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
      // The pair names one change: the earliest's own hearing, or none.
      existing.heardAt = heardAt;
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
  // membership arm, a reach on a keyed entry, a non-`full` reach route, routes
  // beside a `dependsOn`, and an unminted plan; these
  // throws hold the same line for an untyped caller or an `as` cast. A reach
  // plan on an EXTERNAL entry is allowed — non-keyed (D1), or a keyed window /
  // point set (D31): the Postgres reads its loader makes beside its own
  // notify. Keyed, it re-reads a reached tuple whole, so every route is `full`
  // either way.
  // A9: route ids must be unique within the resource — `usesOf` names routes by
  // id, so a duplicate would make a tuple's read-set ambiguous.
  function routingRecordFor<T, P extends ResourceParams>(
    def: Pick<
      ResourceDefinition<T, P>,
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
    if (externalSource && field === "routes") {
      throw new Error(
        `defineExternalResource: "routes" on key "${key}" — an external resource's truth lives outside Postgres, so no keyed route plan may route into it; a non-keyed external declares the Postgres reads its loader makes as "reach"`,
      );
    }
    // A keyed routed entry takes no cascade: it is reached only through the
    // tables its routes name. An upstream's cascade would serve it a second
    // time, on a path the router cannot see — a FULL cascade overriding a
    // scoped routed refill of the same tuple. Route the upstream's tables
    // instead. A `reach` entry may take one: every reach route is `full`, so
    // a cascade and a routed change merge into the tuple's one FULL pending.
    if (field === "routes" && def.dependsOn?.length) {
      throw new Error(
        `defineResource: "routes" and "dependsOn" are exclusive for key "${key}" — a keyed routed entry takes no cascade; route the tables "${def.dependsOn.map((d) => d.resource.key).join('", "')}" read instead`,
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
      // The one keyed entry a reach plan may serve: an external window or
      // point set (D31 — its membership was checked by the caller), whose
      // every change is a FULL re-read of the tuple.
      if (
        def.mode === "keyed" &&
        !(externalSource && membershipField === "membership")
      ) {
        throw new Error(
          `defineResource: "reach" is the non-keyed arm, but key "${key}" is keyed — a keyed entry routes through "routes" and a membership; only an external window or point set (no route reaches it) declares its Postgres reads as a "reach" plan`,
        );
      }
      const notified = (plan as ReachPlan<ResourceParams>).notified ?? [];
      if (!externalSource && notified.length > 0) {
        throw new Error(
          `defineResource: key "${key}" declares notified reads (${notified.map((n) => `"${n.relation}"`).join(", ")}) but is not external — a notified read reaches the entry only through its own notify, which a DB-backed entry does not have; read it through the feed (a route or a relation read)`,
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
      unfed: new Set(
        field === "reach"
          ? ((plan as ReachPlan<ResourceParams>).unfed ?? []).map(
              (u) => u.table,
            )
          : [],
      ),
      relations: new Map(
        field === "reach"
          ? ((plan as ReachPlan<ResourceParams>).relations ?? []).map(
              (r) => [r.relation, r.reason] as const,
            )
          : [],
      ),
      notified: new Map(
        field === "reach"
          ? ((plan as ReachPlan<ResourceParams>).notified ?? []).map(
              (n) => [n.relation, n.reason] as const,
            )
          : [],
      ),
      tagged: taggedOf(
        field === "reach"
          ? ((plan as ReachPlan<ResourceParams>).taggedReads ?? [])
          : [],
      ),
      // `mintRoutePlan` refuses a follow route, so only a reach plan has one.
      via: followsByTable(plan.routes),
      drifted: new Set(),
      relationBases: new Set(),
      driftBases: new Set(),
      seededDrift: new Set(),
      uses: new Map(),
      loadedRoutes: new Set(
        plan.routes.filter((r) => r.via?.loaded === true).map((r) => r.id),
      ),
      loaded: new Map(),
      loading: new Map(),
      followHeld: new Map(),
    };
  }

  // A reach plan's tagged reads, table → its tags (`RoutingRecord.tagged`).
  function taggedOf(
    reads: readonly TaggedRead[],
  ): ReadonlyMap<string, ReadonlySet<string>> {
    const out = new Map<string, Set<string>>();
    for (const { table, tag } of reads) {
      let tags = out.get(table);
      if (!tags) out.set(table, (tags = new Set()));
      tags.add(tag);
    }
    return out;
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
    // The edges of downstreams registered before this entry, waiting for it.
    const waiting = edgesAwaitingUpstream.get(entry.key);
    if (waiting) {
      edgesAwaitingUpstream.delete(entry.key);
      entry.downstream.push(...waiting);
    }
    wireDownstreamEdges(ownDownstreamEdges);
    dagDirty = true;
  }

  // A downstream's edges onto upstreams not registered yet, per upstream key:
  // wired when that upstream registers (`registerEntry`) — so a cascade works
  // in either registration order. One still waiting at a flush names an
  // upstream that never registered: warned at the DAG rebuild.
  const edgesAwaitingUpstream = new Map<string, DownstreamEdge[]>();

  /** Wire a downstream's edges onto its upstreams, or park each until its upstream registers. */
  function wireDownstreamEdges(
    edges: ReadonlyArray<{ upstreamKey: string; edge: DownstreamEdge }>,
  ): void {
    for (const { upstreamKey, edge } of edges) {
      const upstream = registry.get(upstreamKey);
      if (upstream) {
        upstream.downstream.push(edge);
        continue;
      }
      const list = edgesAwaitingUpstream.get(upstreamKey);
      if (list) list.push(edge);
      else edgesAwaitingUpstream.set(upstreamKey, [edge]);
    }
  }

  /**
   * Put a routed entry on the index `routeTableChange` reads, once per table it
   * routes — and, once relation reads have been indexed (the bases are known),
   * under the bases of every relation it reads too.
   */
  function indexRouting(entry: RegistryEntry): void {
    if (!entry.routing) return;
    for (const table of entry.routing.byTable.keys()) indexTable(table, entry);
    if (relationReadsIndexed) indexEntryRelations(entry);
  }

  // Whether `indexRelationReads` has run: from then on a registration (or a
  // deferred bind) expands its own relation reads in `indexRouting`.
  let relationReadsIndexed = false;

  /**
   * Index every routed entry's relation reads (`ReachPlan.relations`) under
   * their relation bases — a write to any base recomputes the entry's targets
   * FULL (`routeEntryChange`'s unrouted-table branch). The bases are injected
   * at boot (server-core's `setRelationBases`, by change-feed), after every
   * resource registered, so this runs then, and every later registration
   * expands its own. A re-index: the bases an earlier call indexed are
   * dropped first (`resetRelationReads`), so a new graph never leaves an old
   * base reaching the entry; calling it twice over one graph is a no-op.
   */
  function indexRelationReads(): void {
    resetRelationReads();
    relationReadsIndexed = true;
    for (const entry of registry.values()) indexEntryRelations(entry);
  }

  /**
   * Back to "relation bases unknown": every base a relation read was indexed
   * under is dropped (one a drifted read also needs stays), and a later
   * registration expands nothing until `indexRelationReads` runs again.
   * server-core's `clearRelationBases` (test support) calls it.
   */
  function resetRelationReads(): void {
    relationReadsIndexed = false;
    for (const entry of registry.values()) {
      const routing = entry.routing;
      if (!routing) continue;
      for (const base of routing.relationBases) {
        if (!routing.driftBases.has(base)) unindexTable(base, entry);
      }
      routing.relationBases.clear();
    }
  }

  function indexEntryRelations(entry: RegistryEntry): void {
    const routing = entry.routing;
    if (!routing) return;
    for (const relation of routing.relations.keys()) {
      for (const base of relationBasesOf(relation)) {
        const via = routing.via.get(base);
        if (via !== undefined) {
          // The other half of `mintReachPlan`'s follow check, known only
          // once the bases are: a view read whole over a followed table
          // would reach every write the follow's gate and match skip.
          throw new Error(
            `resource "${entry.key}" reads the relation "${relation}" whole, and its base "${base}" through ${namedFollows(via)} — the whole read would re-widen the follow. Read "${base}" through the follow only.`,
          );
        }
        if (routing.byTable.has(base)) continue;
        routing.relationBases.add(base);
        if (!indexedUnder(base, entry)) indexTable(base, entry);
      }
    }
  }

  function indexTable(table: string, entry: RegistryEntry): void {
    const list = routedByTable.get(table);
    if (list) list.push(entry);
    else routedByTable.set(table, [entry]);
  }

  function unindexTable(table: string, entry: RegistryEntry): void {
    const list = routedByTable.get(table)?.filter((e) => e !== entry) ?? [];
    if (list.length > 0) routedByTable.set(table, list);
    else routedByTable.delete(table);
  }

  /** The handle `defineResource` / `defineExternalResource` return for an entry. */
  function handleOf<T, P extends ResourceParams>(
    entry: RegistryEntry,
  ): ExternalResource<T, P> {
    return {
      key: entry.key,
      mode: entry.mode,
      schema: entry.schema as z.ZodType<T>,
      preload: entry.preload,
      async load(params: P): Promise<T> {
        // Parse here too: this handle method is the one load path that bypasses
        // `timedLoad`, so it must validate to keep the guarantee total — and
        // canonicalize, as every entry point does. The entry's loader, read at
        // call time: a deferred entry gets its loader at bind.
        return (entry.schema as z.ZodType<T>).parse(
          await entry.loader(canonicalTuple(entry, params)),
        );
      },
      notify(
        params?: P,
        change?: { changedAt?: number; heardAt?: number },
      ): void {
        // A deferred placeholder not bound yet (a deferred external whose
        // watcher fired during the register phase) has nothing to recompute:
        // nothing can be served — so nobody holds a value — before its bind,
        // and its loader refuses until then.
        if (deferred.has(entry.key)) return;
        scheduleNotify(
          entry,
          (params ?? {}) as ResourceParams,
          null,
          change?.changedAt === undefined
            ? undefined
            : {
                changedAt: change.changedAt,
                ...(change.heardAt !== undefined
                  ? { heardAt: change.heardAt }
                  : {}),
              },
        );
      },
    };
  }

  /** D32's refusal: `downstream` cascades from `upstream`, a membership entry. */
  function membershipUpstreamMessage(
    downstream: string,
    upstream: string,
  ): string {
    return `defineResource: "${downstream}" cascades from the keyed window "${upstream}" — a membership drain cascades nothing (D32), so the edge would never fire. To read its rows, follow the collection (\`serveValue\`'s \`follows\`): its routes reach this value, narrowed to the tuple it reads`;
  }

  /** T15's refusal: `downstream` cascades from `upstream`, which is DB-backed. */
  function dbBackedUpstreamMessage(
    downstream: string,
    upstream: string,
  ): string {
    return `defineResource: "${downstream}" dependsOn "${upstream}", which is DB-backed — its writes reach "${downstream}" through the change feed already (its read-set), so a cascade would serve it twice; only an external upstream (truth outside Postgres) cascades. To read a collection's rows, follow it (\`serveValue\`'s \`follows\`)`;
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
    // A patched value is pushed whole once and patched after: only a push
    // entry has frames to patch, a `revalidate` one may answer a sub
    // `up-to-date` against a value the base does not name, and a persisted one
    // is recomputed and read with nobody holding the base.
    if (def.patches === true && !placeholder) {
      const why =
        mode !== "push"
          ? `mode "${mode}"`
          : def.revalidate !== undefined
            ? "a revalidate signature"
            : def.preload !== undefined
              ? "a preload"
              : null;
      if (why !== null)
        throw new Error(
          `defineResource: a patched resource is a plain pushed value — "${def.key}" declares ${why}`,
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

    const routing = routingRecordFor(def, membershipField, externalSource);
    // A follow hook fires only through follow routes: without one in the
    // plan it would never run — a re-point declared and never made.
    if (
      !placeholder &&
      def.onFollowReached !== undefined &&
      (routing === undefined || routing.via.size === 0)
    ) {
      throw new Error(
        `defineResource: "onFollowReached" on key "${def.key}", whose plan has no follow route (\`Route.via\`) — the hook fires only when a followed collection's rows reach a tracked tuple, so it would never run`,
      );
    }
    // The external keyed arm (`ExternalKeyedPolicy`) — never routed: its
    // routes were refused above. The types allow only a bounded window or a
    // point set; this holds the line for a cast.
    if (
      externalSource &&
      membershipField !== null &&
      !(
        (def.membership?.kind === "window" &&
          (def.membership as { windowIdsOf?: unknown }).windowIdsOf ===
            undefined &&
          def.membership.orderSignatureOf === undefined) ||
        (def.membership?.kind === "point" &&
          typeof def.membership.idsOf === "function")
      )
    ) {
      throw new Error(
        `defineExternalResource: key "${def.key}" — an external keyed entry is a bounded window ({ kind: "window", limitOf, familyOf? }) or a point set ({ kind: "point", idsOf }): no alias, and no windowIdsOf / orderSignatureOf (a window's ids are its own read's, and every change re-reads the tuple whole)`,
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
            ...("batch" in def.membership && def.membership.batch !== undefined
              ? { batch: def.membership.batch as PointBatch }
              : {}),
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
      // No upstream-kind rule of its own for a routed upstream: a `routes`
      // entry is a membership entry (D32 below refuses it), and a DB-backed
      // `reach` entry is not external (T15). A reach EXTERNAL upstream may
      // cascade (`edited-files` → `review.plugin-changes`): its cascade carries
      // its own changes, and the downstream declares its own reads.
      const upstream = registry.get(dep.resource.key);
      // D32: a membership drain (a routed window / point / alias, or an
      // external window) cascades nothing, so a cascade out of one would
      // never fire.
      if (upstream?.membership) {
        throw new Error(membershipUpstreamMessage(def.key, upstream.key));
      }
      // T15 — only an external upstream cascades (see `DependsOnEntry`). The
      // type refuses a DB-backed handle; this holds the line for a cast. An
      // upstream not registered yet is checked when it registers (below, the
      // other order) and again at the DAG rebuild; a deferred placeholder
      // reports `externalSource: false` before its bind, so it is left to the
      // bind.
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
          `defineResource: "${def.key}" recomputes on "${r.resource.key}", which is DB-backed — a routed entry routes the tables it reads itself; only an external upstream (truth outside Postgres) may recompute it (a served value reads a collection's rows by following it — \`serveValue\`'s \`follows\`)`,
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
          routedRecompute:
            r.paramsOf === undefined
              ? { upstreamPk: paramsKey(canonicalTuple(upstream, r.params)) }
              : {
                  paramsOf: (params) => {
                    const up = r.paramsOf(params);
                    return up === null
                      ? null
                      : paramsKey(canonicalTuple(upstream, up));
                  },
                },
        },
      });
    }
    // D32 and T15, the other registration order: a downstream registered
    // first already names this entry as its upstream — refused when this
    // entry is a membership entry (routed, or an external window), or
    // DB-backed (a deferred placeholder is checked at its bind).
    if (membership || (!externalSource && !placeholder)) {
      for (const other of registry.values()) {
        if (!other.upstreamKeys.includes(def.key)) continue;
        throw new Error(
          membership
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
      ...(def.patches === true ? { patches: true as const } : {}),
      externalSource,
      ...(def.freshness !== undefined ? { freshness: def.freshness } : {}),
      ...(def.shape !== undefined ? { shape: def.shape } : {}),
      schema: def.schema as z.ZodType<unknown>,
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
      held: new Map(),
      ...(routing ? { routing } : {}),
      upstreamKeys,
      downstream: [],
      onFirstSubscribe: def.onFirstSubscribe as
        ((params: ResourceParams) => void | Promise<void>) | undefined,
      onLastUnsubscribe: def.onLastUnsubscribe as
        ((params: ResourceParams) => void) | undefined,
      onFollowReached: def.onFollowReached as
        ((params: ResourceParams) => Promise<FollowReached>) | undefined,
      revalidate: def.revalidate as
        ((params: ResourceParams) => Promise<string>) | undefined,
      ...(def.readCost !== undefined ? { readCost: def.readCost } : {}),
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
    contract: ResourceContract<T, P> & { keyed?: never },
    bind: () => ServerResourceOptions<T, P>,
    external: DeferredExternal,
  ): ExternalResource<T, P>;
  function defineDeferredResource<T, P extends ResourceParams = ResourceParams>(
    contract: ResourceContract<T, P>,
    bind: () =>
      | ServerResourceOptions<T, P>
      | (KeyedServerResourceOptions<T, P> & ScopePolicy<P>),
    external?: DeferredExternal,
  ): ExternalResource<T, P> {
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
    // say so — checked at bind). An EXTERNAL one (D4) is external from here
    // on, with its declared freshness: `_debug`, the read-set-gap warning and
    // the D5 guard read both before the bind, and the bind cannot change them.
    if (external && contract.keyed) {
      throw new Error(
        `defineDeferredResource: "${key}" is keyed — a deferred external is a non-keyed value`,
      );
    }
    const { entry } = buildEntry(
      {
        key,
        schema: contract.schema,
        mode: contract.keyed ? "keyed" : (external?.mode ?? "push"),
        keyOf: contract.keyed?.keyOf,
        preload: contract.preload,
        ...(contract.optionalParams !== undefined
          ? { optionalParams: contract.optionalParams }
          : {}),
        ...(contract.refusals !== undefined
          ? { refusals: contract.refusals }
          : {}),
        ...(contract.bytes === true ? { bytes: true as const } : {}),
        ...(contract.patches === true ? { patches: true as const } : {}),
        ...(contract.shape !== undefined ? { shape: contract.shape } : {}),
        // The contract's gate until the bind hands the server's own.
        validateParams: contract.validateParams,
        ...(external?.freshness !== undefined
          ? { freshness: external.freshness }
          : {}),
        loader: unbound,
      } as ResourceDefinition<unknown, ResourceParams>,
      external !== undefined,
      true,
    );
    registerEntry(entry, []);
    deferred.set(key, {
      entry,
      bind: () =>
        contractToDefinition(
          external ? "defineExternalResource" : "defineResource",
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
      // Externality (and an external's freshness) is the placeholder's, fixed
      // at definition (D4): a bind restating another is refused, never adopted.
      const externalSource = entry.externalSource === true;
      if (
        def.freshness !== undefined &&
        JSON.stringify(def.freshness) !== JSON.stringify(entry.freshness)
      ) {
        throw new Error(
          `bindDeferredResources: "${key}" was declared ${externalSource ? `external (freshness ${JSON.stringify(entry.freshness ?? null)})` : "DB-backed"} and bound with freshness ${JSON.stringify(def.freshness)} — a deferred resource's externality is fixed where it is defined`,
        );
      }
      const built = buildEntry(def, externalSource);
      Object.assign(entry, {
        loader: built.entry.loader,
        membership: built.entry.membership,
        debounceMs: built.entry.debounceMs,
        routing: built.entry.routing,
        upstreamKeys: built.entry.upstreamKeys,
        onFirstSubscribe: built.entry.onFirstSubscribe,
        onLastUnsubscribe: built.entry.onLastUnsubscribe,
        onFollowReached: built.entry.onFollowReached,
        revalidate: built.entry.revalidate,
        readCost: built.entry.readCost,
        authorize: built.entry.authorize,
        validateParams: built.entry.validateParams,
      } satisfies Partial<RegistryEntry>);
      indexRouting(entry);
      wireDownstreamEdges(built.ownDownstreamEdges);
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
  // Never keyed-ROUTED (D31): its truth is outside Postgres, so no `routes`
  // plan routes into it — `buildEntry` refuses routes a cast let through; a
  // non-keyed one may declare the Postgres reads its loader also makes as a
  // `reach` plan (D1), and so may a keyed one — only as a bounded window or a
  // point set from a shared keyed contract (`ExternalKeyedPolicy`), its reach
  // full-only.
  function defineExternalResource<T, P extends ResourceParams = ResourceParams>(
    def: ExternalDefinition<T, P>,
  ): ExternalResource<T, P>;
  function defineExternalResource<T, P extends ResourceParams = ResourceParams>(
    contract: KeyedResourceContract<T, P>,
    opts: KeyedServerResourceOptions<T, P> & ExternalKeyedPolicy<P>,
  ): ExternalResource<T, P>;
  function defineExternalResource<T, P extends ResourceParams = ResourceParams>(
    contract: ResourceContract<T, P> & { keyed?: never },
    opts: ServerResourceOptions<T, P>,
  ): ExternalResource<T, P>;
  function defineExternalResource<T, P extends ResourceParams = ResourceParams>(
    a: ResourceDefinition<T, P> | ResourceContract<T, P>,
    opts?:
      | ServerResourceOptions<T, P>
      | (KeyedServerResourceOptions<T, P> & ExternalKeyedPolicy<P>),
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
  //  - D32: a membership entry has no downstream. D32 refuses a cascade out
  //    of every membership entry (a routed one or an external window), in
  //    both registration orders, so the membership drains cascade nothing.
  //  - T15: every upstream is external — a deferred placeholder excepted, which
  //    reports `externalSource: false` until its bind (checked then).
  function rebuildDag(): void {
    if (!dagDirty) return;

    // Asserted before the DAG counts as rebuilt, so a violation stays loud on
    // every flush rather than once.
    for (const entry of registry.values()) {
      if (entry.membership && entry.downstream.length > 0) {
        throw new Error(
          `[resources] membership entry "${entry.key}" has downstream edges (${entry.downstream.map((d) => d.downstreamKey).join(", ")}) — D32 must refuse a cascade out of a membership entry`,
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
  // fields its kind declares (`ExactServerFrame`, `network/live/resource-protocol`
  // — checked however the frame was built, a variable or a spread included): a
  // new field or kind is an edit there, which moves `PROTOCOL` — so tabs
  // reading the old vocabulary never share a socket with tabs reading the new
  // one.
  // Every frame the runtime sends goes through here. A frame the socket does
  // not accept (Bun discards one sent past the connection's backpressureLimit
  // — a post-restart replay of every tab's sub set on one shared socket, with
  // the boot catch-up's pushes behind it, reaches it) would otherwise be lost
  // with no trace: the tab keeps the value it had, the server's version moves
  // on, and nothing ever tells the tab — the "missed-updates" the client's
  // probe found after restarts. So an unaccepted frame opens the socket's
  // BACKLOG: it and every later frame wait there in order (a delta must never
  // overtake the frame it builds on) and go out on `drain`. A send that throws
  // (a socket already closing) is the close handler's to clean up.
  function deliver(state: SocketState, str: string): void {
    if (state.closing) return;
    const backlog = state.backlog;
    if (backlog !== undefined) {
      backlog.frames.push(str);
      backlog.chars += str.length;
      if (
        backlog.chars > BACKLOG_MAX_CHARS ||
        Date.now() - backlog.since > BACKLOG_MAX_AGE_MS
      )
        closeBacklogged(state);
      return;
    }
    let accepted: number;
    try {
      accepted = state.ws.send(str);
      // eslint-disable-next-line promise-safety/no-bare-catch
    } catch {
      return; // close handler will clean up
    }
    if (accepted === 0) {
      state.backlog = { frames: [str], chars: str.length, since: Date.now() };
      backlogEpisodes++;
      console.warn(
        `[resource-runtime] socket buffer full: holding frames until it drains (${backlogEpisodes} episode(s) this boot)`,
      );
    }
  }

  // The socket drained: send what it held back, in order, until it refuses
  // one again (that one stays first in line for the next drain).
  function flushBacklog(state: SocketState): void {
    const backlog = state.backlog;
    if (backlog === undefined) return;
    let sent = 0;
    for (const str of backlog.frames) {
      let accepted: number;
      try {
        accepted = state.ws.send(str);
        // eslint-disable-next-line promise-safety/no-bare-catch
      } catch {
        return; // close handler will clean up
      }
      if (accepted === 0) break;
      sent++;
      backlog.chars -= str.length;
    }
    backlog.frames.splice(0, sent);
    if (backlog.frames.length === 0) {
      console.warn(
        `[resource-runtime] socket buffer drained: held frames delivered after ${Date.now() - backlog.since}ms`,
      );
      state.backlog = undefined;
    }
  }

  // A peer that stopped reading (or a drain that never came): close it rather
  // than hold without bound. Its
  // tabs reconnect and replay — every value re-read, so nothing is lost.
  function closeBacklogged(state: SocketState): void {
    const held = state.backlog;
    state.backlog = undefined;
    state.closing = true;
    reportLoaderError(
      "live-state socket closed: its peer stopped reading",
      new Error(
        `held ${held?.frames.length ?? 0} frame(s) (${held?.chars ?? 0} chars) for ${held ? Date.now() - held.since : 0}ms past the socket's buffer; closed so its tabs reconnect and replay`,
      ),
    );
    try {
      state.ws.close(1013, "live-state backlog over its bound");
      // eslint-disable-next-line promise-safety/no-bare-catch
    } catch {
      // already closing — the close handler cleans up
    }
  }

  // Returns the frame's length in UTF-16 chars (0 when nothing was sent).
  function sendJson<F extends ServerFrame>(
    ws: RuntimeSocket,
    obj: ExactServerFrame<F>,
  ): number {
    const state = sockets.get(ws);
    if (state === undefined) return 0; // closed: nothing holds it
    const str = JSON.stringify(obj);
    const to = audienceOn(state, obj, null);
    deliver(state, to === null ? str : addressFrame(to, str));
    noteSent(state, obj, null, str.length, to);
    return str.length;
  }

  // The tabs a frame is addressed to on this socket, or null — it goes out
  // bare, to every tab: until its peer routes addressed frames
  // (`SocketState.addressed`), and whenever `frameAudience` names no tab. The
  // body is serialized once per frame; only the address differs per socket.
  function audienceOn(
    state: SocketState,
    obj: ServerFrame,
    pk: string | null,
  ): ReadonlySet<string> | null {
    return state.addressed === true ? frameAudience(state, obj, pk) : null;
  }

  // Which tabs on this socket a frame is for, so none receives, parses and
  // drops a frame answering another tab's subscription:
  //
  // - an answer to one tab's request (`tabId`) — a sub-ack, an `up-to-date`,
  //   an `up-to-date-batch` — goes to that tab, and a whole-value sub-ack also
  //   to the holders still awaiting their own answer (`awaiting`: a replay
  //   herd shares one copy). Every other holder is already at the version it
  //   carries (it gets every change of the tuple) and would drop it as stale
  //   or not its own. Who a whole value reached is recorded (`shipped.to`),
  //   so `alreadyShipped` never answers a tab from a value it never got.
  // - any other frame naming a tuple goes to every tab holding it
  //   (`SocketSubRecord.tabs` — exactly the tabs whose client gate applies
  //   it), plus the asker of a refusal that registered nothing.
  // - null (every tab) for a ping, a frame no tab is known for, or one an
  //   untagged (legacy, `""`) holder holds.
  function frameAudience(
    state: SocketState,
    obj: ServerFrame,
    pk: string | null,
  ): ReadonlySet<string> | null {
    if (obj.kind === "ping") return null;
    const asker =
      "tabId" in obj && typeof obj.tabId === "string" ? obj.tabId : undefined;
    const to = new Set<string>();
    if (asker !== undefined) to.add(asker);
    const answersAsker =
      obj.kind === "sub-ack" ||
      obj.kind === "up-to-date" ||
      obj.kind === "up-to-date-batch";
    if (answersAsker && asker !== undefined) {
      if (obj.kind === "sub-ack" && "value" in obj) {
        const rec = state.subs.get(obj.key)?.get(pk ?? paramsKey(obj.params));
        if (rec !== undefined) {
          for (const tab of rec.awaiting) if (rec.tabs.has(tab)) to.add(tab);
        }
      }
    } else {
      const addHolders = (key: string, tuplePk: string): void => {
        const rec = state.subs.get(key)?.get(tuplePk);
        if (rec !== undefined) for (const tab of rec.tabs) to.add(tab);
      };
      if (obj.kind === "up-to-date-batch") {
        for (const e of obj.entries) addHolders(e.key, paramsKey(e.params));
      } else {
        addHolders(obj.key, pk ?? paramsKey(obj.params));
      }
    }
    if (to.size === 0 || to.has("")) return null;
    return to;
  }

  // Keep a socket's record of what it was sent of a tuple's value
  // (`SocketSubRecord.shipped`). Called after each frame is delivered (or
  // queued in its backlog, in order). `pk` is the frame's params key when the
  // caller already has it (one broadcast, many sockets), else null.
  function noteSent(
    state: SocketState,
    obj: ServerFrame,
    pk: string | null,
    chars: number,
    to: ReadonlySet<string> | null,
  ): void {
    const position = state.framesSent++;
    // An answer settles its asker's wait (`SocketSubRecord.awaiting`).
    if (obj.kind === "up-to-date-batch") {
      if (obj.tabId !== undefined) {
        for (const e of obj.entries) {
          state.subs
            .get(e.key)
            ?.get(paramsKey(e.params))
            ?.awaiting.delete(obj.tabId);
        }
      }
      return;
    }
    if (!("key" in obj) || !("params" in obj)) return;
    const rec = state.subs
      .get(obj.key)
      ?.get(pk ?? paramsKey(obj.params as ResourceParams));
    if (rec === undefined) return;
    // Not a `sub-error`: a refused tab still takes the next whole value.
    if (
      (obj.kind === "sub-ack" || obj.kind === "up-to-date") &&
      obj.tabId !== undefined
    ) {
      rec.awaiting.delete(obj.tabId);
    }
    switch (obj.kind) {
      case "sub-ack":
        if ("value" in obj) {
          rec.shipped = { fullAt: position, version: obj.version, chars, to };
        }
        return;
      case "update":
        rec.shipped = { fullAt: position, version: obj.version, chars, to };
        return;
      case "delta":
      case "patch":
        if (rec.shipped !== undefined) rec.shipped.version = obj.version;
        return;
      case "invalidate":
      case "sub-error":
        rec.shipped = undefined;
        return;
      case "up-to-date":
      case "ack":
        return; // no value: the holders keep what they hold
    }
  }

  // Whether a sub that reached this socket at frame position `arrivedAt` is
  // already answered by what the socket was sent since: a frame carrying the
  // tuple's whole value, sent AFTER the sub arrived, and a version at least
  // `version` (the one this answer would carry). Every tab holding the tuple
  // gets every frame of it (a bare frame reaches every tab; an addressed one
  // names every holder — `frameAudience`), and a tab
  // registers its sub — or, replaying, resets its version to -1 — BEFORE
  // sending it, so a frame the server sent after receiving the sub reached
  // that tab while it held the sub, and was applied (nothing it held could be
  // newer): the tab already holds this tuple at the recorded version, and the
  // whole value it would be sent now would be dropped as not newer. A
  // restart's replay is the herd this exists for: every tab on one socket
  // restates the same tuples at once, the reads join one flight, and each tab
  // used to get its own full copy of every value (one 2026-11-04 restart:
  // ~7.6 MB per tab, six tabs, ~45 MB through one connection, past Bun's
  // backpressure limit). A frame sent BEFORE the sub arrived may have reached
  // the tab before it registered, so it never answers one.
  // An addressed value reached only the tabs it named (`shipped.to`).
  function alreadyShipped(
    state: SocketState,
    key: string,
    pk: string,
    arrivedAt: number,
    version: number,
    tabId: string,
  ): { version: number; chars: number } | null {
    const shipped = state.subs.get(key)?.get(pk)?.shipped;
    if (shipped === undefined) return null;
    if (shipped.fullAt < arrivedAt || shipped.version < version) return null;
    if (shipped.to !== null && !shipped.to.has(tabId)) return null;
    return shipped;
  }

  // Broadcast one frame to N subscribers: serialize ONCE, send the string to
  // each socket. The per-subscriber `sendJson` loop this replaces stringified
  // the identical frame N times — for a large value that multiplied the
  // delivery path's allocation churn by subscriber count (the ±60–70 MB/10 s
  // GC sawtooth; research/perfs/2026-07-16-main-paging-victim-investigation-PLAN.md
  // §B2). Synchronous end-to-end so the no-await-before-send property of the
  // push path (H5a) is untouched.
  // Returns the serialized frame's length in UTF-16 chars (0 when nothing was
  // sent) — the delivery's `frameChars` measure, read off the one string that
  // was already built, so measuring costs nothing extra.
  function broadcastJson<F extends ServerFrame>(
    subs: readonly SocketState[],
    obj: ExactServerFrame<F>,
  ): number {
    if (subs.length === 0) return 0;
    const str = JSON.stringify(obj);
    const pk = "params" in obj ? paramsKey(obj.params as ResourceParams) : null;
    for (const s of subs) {
      const to = audienceOn(s, obj, pk);
      deliver(s, to === null ? str : addressFrame(to, str));
      noteSent(s, obj, pk, str.length, to);
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
  // coalesce onto one flush. The immediate (non-debounced) path. A notify landing
  // mid-flush asks the live loop for another pass instead (see `flushState`).
  function scheduleFlush(): void {
    if (flushState === "running") flushState = "rerun";
    if (flushState !== "idle") return;
    flushState = "queued";
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
      if (batchDepth === 0) {
        // Every entry with work gets its own release: the immediate flush, or
        // a debounced entry's window (never the immediate flush, which would
        // leave it held with no timer to release it).
        for (const entry of registry.values()) {
          if (entry.pendingNotifies.size > 0 || entry.pendingAcks.size > 0) {
            armFlush(entry);
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
      /** When a host watch heard the change `changedAt` names (only with it). */
      heardAt?: number;
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
    // Whatever reached this tuple also reached the state the previous backend
    // handed over for it (`EpochHandoff`).
    dirtyShadows(entry.key, pk);
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
      opts?.changedAt !== undefined ? opts.heardAt : undefined,
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
    // Throttled entries drain at most once per window. Nothing to do while a
    // drain is already due or a timer armed (that drain takes this change too —
    // never re-armed, so a continuously-ticking source still drains every
    // debounceMs). Otherwise: outside the window the last drain opened, drain
    // now (the leading edge: an isolated change is never held); inside it, arm
    // a timer for the window's remainder.
    if (entry.debounceMs) {
      if (entry.debounceTimer !== undefined || entry.debounceDue) return;
      const sinceDrain =
        entry.debounceDrainedAt === undefined
          ? Infinity
          : performance.now() - entry.debounceDrainedAt;
      if (sinceDrain >= entry.debounceMs) {
        entry.debounceDue = true;
        entry.debounceReleasedAt = performance.now();
        scheduleFlush();
        return;
      }
      entry.debounceTimer = setTimeout(() => {
        entry.debounceTimer = undefined;
        entry.debounceDue = true;
        entry.debounceReleasedAt = performance.now();
        scheduleFlush();
      }, entry.debounceMs - sinceDrain);
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
    entry.unprovenBases?.delete(pk);
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
    {
      lastReplaceAt?: number;
      lastFloorAt?: number;
      lastAdvanceAt?: number;
      l2PositionAt?: number;
      /** Why a floor persist did not advance the floor, by reason (`_debug`). */
      advanceRefusals?: Map<string, number>;
    }
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

  // The snapshot was just rebuilt from a WHOLE read (a FULL drain, a sub-ack
  // seed, the L2 boot seed): it misses no change routed before that read, so
  // a change an earlier drain failed to apply no longer counts against it
  // (`RegistryEntry.unprovenBases`).
  function markRebuilt(entry: RegistryEntry, pk: string): void {
    entry.unprovenBases?.delete(pk);
  }

  // The alias tuple's snapshot may miss a change that reached (or should have
  // reached) it — never advance its floor until a whole read rebuilds it.
  function markUnapplied(entry: RegistryEntry, pk: string): void {
    if (!isUnboundedWindow(entry) || entry.snapshots?.has(pk) !== true) return;
    (entry.unprovenBases ??= new Set()).add(pk);
  }

  // The pendings a drain APPLIED to their tuple's snapshot (a scoped refill
  // written back, a FULL rebuild, a scoped pending that names nothing). Every
  // other pending the drain took marks its alias tuple unproven when the drain
  // settles (`drainEntry`) — positively tracked, so a failure path nobody
  // thought of still counts as one.
  const appliedPendings = new WeakSet<PendingNotify>();

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
    const cancelledCut = cancelCuttingFloors(slot);
    const cancelledWindow = armed !== undefined || cancelledCut;
    await enqueuePersist(entry, pk, async () => {
      try {
        await persist(entry.key, pk, value, watermark, {
          mode: "replace",
          definition: definitionOf(entry),
          guardTables: tablesRead,
        });
      } catch (err) {
        reportLoaderError(`snapshot persist failed for ${entry.key}`, err);
        if (cancelledWindow) armFloorPersist(entry, pk);
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
      if (opts.routedCut && advanceRefusal(entry) === null) {
        cutThenFloorPersist(entry, pk, slot);
      } else {
        void enqueuePersist(entry, pk, () => runFloorPersist(entry, pk));
      }
    }, persistWindowMs);
    (timer as { unref?: () => void }).unref?.();
    armedFloors.set(slot, timer);
  }

  // ── Advancing an alias's floor (research/2026-10-30-global-boot-catch-up-
  // per-key-floors.md, part B) ──
  //
  // A floor persist can only LOWER the row's position: the snapshot's base is
  // its last FULL read, and a scoped refill reads only its ids. So the
  // position of an alias that changes all day sits at its last FULL rebuild
  // (the hourly compact), and every boot re-routes that hour of its changes.
  // It may be RAISED to a routed cut X (`routedCut`) when, AFTER the cut
  // resolved, the tuple is SETTLED: a snapshot, a known base floor, no pending
  // notify, not draining, and no change a drain took without applying
  // (`unprovenBases`). Then every change below X was routed (the cut), each
  // routed change either rebuilt the base or was applied to it (settled), so
  // the value reconstructed in that same synchronous step reflects every
  // transaction below X — exactly what a row's position claims. Any doubt —
  // no cut, a tuple not settled, an entry whose changes do not all come
  // through the router — writes the plain floor persist instead.

  // The one cut in flight, joined by every floor window that fires while it
  // runs: a later cut than needed is still a cut (the check runs after it).
  let cutInFlight: Promise<RoutedCut> | null = null;
  function takeCut(cut: () => Promise<RoutedCut>): Promise<RoutedCut> {
    if (cutInFlight) return cutInFlight;
    const flight = cut().then(
      (c) => c,
      (err: unknown): RoutedCut => ({
        kind: "unproven",
        reason: `the cut threw: ${String(err)}`,
      }),
    );
    cutInFlight = flight;
    void flight.then(() => {
      if (cutInFlight === flight) cutInFlight = null;
    });
    return flight;
  }

  // The floor windows waiting on a cut, by slot. A replace (`persistReplace`)
  // or a shutdown (`dropPendingPersists`) cancels one exactly as it clears an
  // armed timer: the window's changes are in the replace's value (or the
  // changelog), and a link enqueued after the replace could otherwise read the
  // pre-replace snapshot before its drain rebuilds it.
  const cuttingFloors = new Map<string, Set<{ cancelled: boolean }>>();
  // Cancel every window of `slot` waiting on its cut; true when there was one.
  function cancelCuttingFloors(slot: string): boolean {
    const waiting = cuttingFloors.get(slot);
    if (waiting === undefined) return false;
    for (const w of waiting) w.cancelled = true;
    cuttingFloors.delete(slot);
    return true;
  }

  // Take a cut OFF the persist chain (a replace queued meanwhile never waits on
  // it), then enqueue the floor link with it; the link judges the tuple when
  // it runs, which is after the cut resolved.
  function cutThenFloorPersist(
    entry: RegistryEntry,
    pk: string,
    slot: string,
  ): void {
    const waiting = { cancelled: false };
    let set = cuttingFloors.get(slot);
    if (set === undefined) {
      set = new Set();
      cuttingFloors.set(slot, set);
    }
    set.add(waiting);
    void takeCut(opts.routedCut!).then((cut) => {
      const current = cuttingFloors.get(slot);
      current?.delete(waiting);
      if (current?.size === 0) cuttingFloors.delete(slot);
      if (waiting.cancelled) return;
      void enqueuePersist(entry, pk, () => runFloorPersist(entry, pk, cut));
    });
  }

  // Why an entry's floor is never advanced (the first reason), or null: only a
  // persisted alias, every change of which reaches it through the change
  // feed's router — no drift (a read no route names), nothing unfed or
  // notified in-process, no upstream, not deferred or external.
  function advanceRefusal(entry: RegistryEntry): string | null {
    const routing = entry.routing;
    if (!isUnboundedWindow(entry) || !isPersisted(entry)) {
      return "not-a-persisted-alias";
    }
    if (routing === undefined) return "unrouted";
    if (deferred.has(entry.key)) return "deferred";
    if (entry.externalSource) return "external";
    if (entry.upstreamKeys.length > 0) return "upstream";
    if (
      routing.drifted.size > 0 ||
      routing.driftBases.size > 0 ||
      routing.seededDrift.size > 0
    ) {
      return "drift";
    }
    if (routing.unfed.size > 0) return "unfed-read";
    if (routing.notified.size > 0) return "notified-read";
    if (routing.tagged.size > 0) return "tagged-read";
    if (routing.via.size > 0) return "follow-read";
    return null;
  }

  // Why the tuple cannot take the cut right now (null: it is settled under
  // it). Read in the same synchronous step as the value it gates.
  function advanceBlock(
    entry: RegistryEntry,
    pk: string,
    cut: RoutedCut,
    floor: string,
  ): string | null {
    if (cut.kind !== "cut") return `unproven: ${cut.reason}`;
    const refusal = advanceRefusal(entry);
    if (refusal !== null) return refusal;
    if (entry.pendingNotifies.has(pk)) return "pending";
    if (entry.draining.has(pk)) return "draining";
    if (entry.unprovenBases?.has(pk) === true) return "unapplied-change";
    // A FULL rebuild that read after the cut was captured already stands on a
    // newer base: the plain floor persist writes that one.
    if (BigInt(cut.cutXid) < BigInt(floor)) return "base-above-cut";
    return null;
  }

  function countAdvanceRefusal(key: string, reason: string): void {
    // `unproven: <why>` counts under its kind; the why is in the log line.
    const kind = reason.startsWith("unproven") ? "unproven" : reason;
    const refusals = (statsOf(key).advanceRefusals ??= new Map());
    refusals.set(kind, (refusals.get(kind) ?? 0) + 1);
  }

  // The tables a floor persist's A6 guard judges, and a first INSERT records:
  // a routed entry's route tables and relation reads (its reads, by
  // construction), else the key's read-set union. Every persisted entry in
  // production is routed (central persists nothing; change-feed refuses an
  // unrouted DB-backed resource, D6), so the union arm is reached only by an
  // unrouted entry in a DB-free harness.
  function floorGuardTables(entry: RegistryEntry): string[] {
    if (entry.routing) {
      return [
        ...new Set([
          ...entry.routing.plan.routes.map((r) => r.table),
          ...entry.routing.relations.keys(),
        ]),
      ].sort();
    }
    return opts.readSet?.(entry.key) ?? [];
  }

  // One floor persist, run on the chain: the value is reconstructed from the
  // snapshot as it stands NOW (a replace queued ahead of it has already
  // rebuilt it), floored by its base floor — or, with a `cut` the tuple is
  // settled under (`advanceBlock`, judged in this same synchronous step),
  // ADVANCED to the cut. Nothing to write without a snapshot, without a known
  // floor, or once the key stopped persisting.
  async function runFloorPersist(
    entry: RegistryEntry,
    pk: string,
    cut?: RoutedCut,
  ): Promise<void> {
    const persist = opts.persistSnapshot;
    const snapshot = entry.snapshots?.get(pk);
    const floor = entry.baseFloors?.get(pk);
    if (!persist || !snapshot || floor === undefined || !isPersisted(entry)) {
      return;
    }
    const block =
      cut === undefined ? null : advanceBlock(entry, pk, cut, floor);
    const advance = cut?.kind === "cut" && block === null ? cut : null;
    if (block !== null) countAdvanceRefusal(entry.key, block);
    try {
      await persist(
        entry.key,
        pk,
        valueOfSnapshot(entry, snapshot),
        advance ? advance.cutXid : floor,
        {
          mode: advance ? "advance" : "floor",
          definition: definitionOf(entry),
          guardTables: floorGuardTables(entry),
        },
      );
      const st = statsOf(entry.key);
      st.lastFloorAt = Date.now();
      if (advance) st.lastAdvanceAt = st.lastFloorAt;
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
  //   `SnapEncoder`.
  // The hash is the host's (`opts.snapHash`), the portable `hash64` by default.
  const hashEncoder: SnapEncoder = opts.snapHash ?? hashSnapEncoder;
  function snapEncoderFor(entry: RegistryEntry): SnapEncoder {
    return isUnboundedWindow(entry) ? retainSnapEncoder : hashEncoder;
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

  // The flush loop, entered only from the `queued` microtask: never two at once.
  // Re-drains while mid-pass notifies ask for another pass (`rerun`). The check
  // that ends the loop and the release to `idle` run in ONE synchronous segment
  // after the pass's wrapper has fully settled, so no notify can land between
  // them (see `flushState`).
  async function flushNotifies(): Promise<void> {
    if (flushState !== "queued") {
      throw new Error(
        `[resources] flushNotifies entered in state ${flushState} — only the queued microtask runs a flush`,
      );
    }
    flushState = "running";
    try {
      for (;;) {
        // A fresh pass is progress: the previous one settled (see `pushStall`).
        flushPassStartedAt = performance.now();
        // Each pass runs inside the injected flush wrapper (server:
        // recordEntrySpan("flush", ...)) so each pass is one `flush` entry and the
        // per-resource `push` loads it triggers nest under it (byParent =
        // head-of-line blocking attribution). Identity passthrough on central.
        await runPassCriticalPath();
        if (currentFlushState() === "rerun") {
          flushState = "running";
          continue;
        }
        flushState = "idle";
        return;
      }
    } catch (err) {
      // A failed pass must not swallow the pass a notify asked for meanwhile:
      // re-queue it before reporting, so the scheduler is never left wedged.
      const rerun = currentFlushState() === "rerun";
      flushState = "idle";
      if (rerun) scheduleFlush();
      reportLoaderError("flush pass failed", err);
    } finally {
      flushPassStartedAt = null;
    }
  }

  // Run one pass, resolving once its CRITICAL PATH is done — every drain a
  // deeper level could depend on — while its leaf lanes may still be loading.
  // The pass's wrapper (its `flush` span) stays open until the lanes settle, so
  // their loads and deliveries are judged inside an open entry. A wrapper
  // failure before the release fails this pass (the loop reports it); one after
  // it is reported here, the loop having moved on.
  async function runPassCriticalPath(): Promise<void> {
    let released = false;
    let release!: () => void;
    const criticalPath = new Promise<void>((resolve) => {
      release = () => {
        released = true;
        resolve();
      };
    });
    const run = () => runFlushPass(release);
    const settled = (opts.wrapFlush ? opts.wrapFlush(run) : run()).catch(
      (err: unknown) => {
        if (!released) throw err;
        reportLoaderError("flush pass failed", err);
      },
    );
    await Promise.race([criticalPath, settled]);
  }

  // One flush pass. Each depth level runs concurrently; a barrier between levels
  // so every cascade merged into a (strictly-deeper) downstream settles before
  // that downstream level drains. A slow loader can no longer head-of-line-block
  // an unrelated entry at the same or an earlier depth.
  //
  // Only an entry with downstream is ON the barrier. A leaf (no downstream —
  // every membership entry, most values) has nothing deeper waiting for it, so
  // its drain runs as a lane: the pass releases the flush loop once the
  // barrier entries are done, and the next pass runs while a slow leaf (a round
  // trip to a busy agent process, 2–10 s) is still loading — a change landing
  // meanwhile no longer waits for it. The pass itself awaits its lanes before
  // returning, so its wrapper encloses them.
  // research/2026-10-30-framework-live-flush-leaf-drain-lanes.md
  async function runFlushPass(release: () => void): Promise<void> {
    rebuildDag();
    const lanes: Promise<void>[] = [];
    for (const level of topoLevels) {
      const barrier: Promise<void>[] = [];
      for (const entry of level) {
        if (entry.downstream.length === 0) {
          const lane = startLane(entry);
          if (lane) lanes.push(lane);
        } else {
          barrier.push(drainOnBarrier(entry));
        }
      }
      await Promise.all(barrier);
    }
    release();
    await Promise.all(lanes);
  }

  // An entry with downstream drains on the pass's barrier. A lane of its own
  // still in flight (it was a leaf until a downstream registered) settles
  // first: one drain per entry at a time.
  async function drainOnBarrier(entry: RegistryEntry): Promise<void> {
    if (entry.lane) await entry.lane.done;
    await drainEntry(entry);
  }

  // Start a leaf's drain as its lane, or leave its work held when one is
  // already in flight (the lane re-arms it on settle). Returns the new lane.
  function startLane(entry: RegistryEntry): Promise<void> | undefined {
    if (entry.lane) return undefined;
    const done = drainEntry(entry)
      .catch((err: unknown) => {
        // A drain reports its own loader failures; reaching here is a bug in
        // the drain itself — loud, and the lane still clears.
        reportLoaderError(`drain failed for ${entry.key}`, err);
      })
      .finally(() => {
        entry.lane = undefined;
        rearmAfterLane(entry);
      });
    // Set before any continuation runs, so the `finally` above always clears it.
    entry.lane = { done, startedAt: performance.now() };
    return done;
  }

  // What a pass held while the lane was in flight, released now: the entry's
  // own window (a debounced entry whose window opened meanwhile) or its
  // pending, and any downstream a cascade fed (an edge that registered while
  // the lane ran — a pass drains a downstream only behind the barrier).
  function rearmAfterLane(entry: RegistryEntry): void {
    if (entry.debounceDue) scheduleFlush();
    else if (entry.pendingNotifies.size > 0 || entry.pendingAcks.size > 0)
      armFlush(entry);
    for (const edge of entry.downstream) {
      const down = registry.get(edge.downstreamKey);
      if (down && down.pendingNotifies.size > 0) armFlush(down);
    }
  }

  // Cascade this entry's change into its downstream edges — always FULL: only
  // a non-membership entry has downstream (D32), and it recomputes
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
    heardAt?: number,
  ): Promise<void> {
    for (const edge of entry.downstream) {
      const down = registry.get(edge.downstreamKey);
      if (!down) continue;
      let derived: ResourceParams[];
      if (edge.routedRecompute) {
        const recompute = edge.routedRecompute;
        if (recompute.paramsOf === undefined) {
          // Only the one upstream tuple the routed entry compiles from; its
          // change moved the SQL, so every tuple's memoized read-set is stale.
          if (paramsKey(params) !== recompute.upstreamPk) continue;
          down.routing?.uses.clear();
          // The tuples a table change would consider (`tracked`, never an
          // O(sockets) scan).
          derived = routedTargets(down).map(([, p]) => p);
        } else {
          // Per tuple: only the tracked tuples compiling from THIS upstream
          // tuple — their SQL moved; every other tuple's read-set holds.
          const changed = paramsKey(params);
          derived = [];
          for (const [pk, p] of routedTargets(down)) {
            let of: string | null;
            try {
              of = recompute.paramsOf(p);
            } catch (err) {
              // A throwing mapping cannot say which tuples it names: this
              // tuple recomputes (never a skip a broken mapping hides).
              reportLoaderError(
                `recomputeOn paramsOf failed (${entry.key} → ${edge.downstreamKey})`,
                err,
              );
              of = changed;
            }
            if (of !== changed) continue;
            down.routing?.uses.delete(pk);
            derived.push(p);
          }
        }
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
          undefined,
          heardAt,
        );
      }
      // A non-debounced downstream drains at its (deeper) level of this very
      // cycle; a debounced one waits for its own window, which the cascade
      // arms like a notify would.
      if (derived.length > 0 && down.debounceMs) armFlush(down);
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
    const version = mintVersion(entry, pk);
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
                undefined,
                seedAckTx,
                pendingEntry.lastNotifyAt,
              ),
            )
          : getResourceValue(
              entry,
              params,
              undefined,
              undefined,
              undefined,
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
          persistReadSet(entry),
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
          pendingEntry,
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
          ...frameTiming(pendingEntry),
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
        delivery(pendingEntry, subs.length, frameChars),
      );
    } else if (owns && valueComputed) {
      // Zero subscribers but a value was computed for a snapshot that outlives
      // them (a persisted alias): still seed/replace the snapshot so the next
      // membership diff has a base. An untracked tuple seeds nothing — no
      // drain would keep that snapshot current.
      diffKeyed(entry, pk, value);
    } else if (owns && subs.length === 0 && !keepsIdleSnapshot(entry)) {
      // Tracked, yet nobody to send to: only lingering sockets hold the tuple
      // (`detached`), and this change moved past the snapshot without reading
      // it. Kept, it would be the stale base every later diff — and routing —
      // reads. Dropped, the replay (which this version makes reload) reseeds
      // it from its own read.
      evictSnapshot(entry, pk);
    }
    // The order-signature map's lifecycle mirrors the snapshot's: whenever the
    // FULL value replaced the snapshot above, reseed the sigs from it too —
    // and the snapshot's base floor is now this value's flight watermark.
    if (owns && valueComputed) {
      reseedOrderSigs(entry, params, value);
      setBaseFloor(entry, pk, flightWatermark);
      markRebuilt(entry, pk);
      appliedPendings.add(pendingEntry);
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
    const prevUnproven = entry.unprovenBases?.has(pk) === true;
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
    // A sub-ack may have seeded the snapshot (and set its base floor to its own
    // read's watermark) while this drain read, when there was none before. The
    // snapshot written here is still `prev` + this refill, so its floor is
    // `prev`'s — keeping the sub-ack's would claim a newer base than the value
    // has, and a floor persist into a missing row (or under another writer's
    // higher position) would then skip the commits in between on catch-up.
    const rebasedUnder = snapshots.get(pk) !== prev;
    snapshots.set(pk, nextSnapshot);
    if (rebasedUnder) {
      setBaseFloor(entry, pk, prevBase);
      // …and so is its proof: a change `prev` missed is still missing.
      if (prevUnproven) markUnapplied(entry, pk);
    }
    appliedPendings.add(pendingEntry);

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
      const version = mintVersion(entry, pk);
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
          ...frameTiming(pendingEntry),
        };
        const frameChars = broadcastJson(subs, msg);
        opts.onDelivered?.(
          entry.key,
          delivery(pendingEntry, subs.length, frameChars),
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
    // A debounced entry drains only when its own window elapsed: a flush some
    // other resource scheduled leaves its pending (and owed acks) held, or a
    // busy server would drain it on every change and the declared throttle
    // would bound nothing.
    if (entry.debounceMs) {
      if (!entry.debounceDue) return;
      entry.debounceDue = false;
    }
    if (entry.pendingNotifies.size === 0 && entry.pendingAcks.size === 0) {
      return;
    }
    // A throttled drain opens the window the next change waits out.
    if (entry.debounceMs) entry.debounceDrainedAt = performance.now();
    const pending = Array.from(entry.pendingNotifies.values());
    // Each pending's share of the declared hold: enqueue → the window's release.
    const releasedAt = entry.debounceReleasedAt;
    if (entry.debounceMs && releasedAt !== undefined)
      for (const p of pending)
        p.holdMs = Math.max(0, releasedAt - p.enqueuedAt);
    // Each pending's wait for the lane: released → this drain taking it.
    const drainStartedAt = performance.now();
    for (const p of pending)
      p.queueMs = Math.max(
        0,
        drainStartedAt - (p.enqueuedAt + (p.holdMs ?? 0)),
      );
    entry.pendingNotifies.clear();
    // From here every taken pending must end applied or mark its tuple
    // (`markUnapplied`, in the `finally`) — a throw anywhere below included.
    const byPk = new Map<string, PendingNotify>();
    try {
      const owedAcks = Array.from(entry.pendingAcks.values());
      entry.pendingAcks.clear();
      // The acks owed to skipped tuples (see `PendingAck`): folded into the
      // tuple's real pending when this drain has one — its frame (or its own ack)
      // then carries them — and otherwise sent right here, as a standalone ack,
      // before any persisted or membership branch can see the tuple.
      for (const p of pending) byPk.set(paramsKey(p.params), p);
      for (const owed of owedAcks) {
        const real = byPk.get(paramsKey(owed.params));
        if (!real) {
          if (owed.overflow) recordAckOverflow(entry.key);
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
      for (const p of pending) {
        if (p.sourceTxOverflow) recordAckOverflow(entry.key);
      }
      if (pending.length === 0) return;
      // Mark the taken pks as draining until the whole drain settles (see
      // `RegistryEntry.draining`): coarser than per-pk, which only ever makes the
      // router deliver a value-role change it could have dropped — never the
      // reverse.
      for (const pk of byPk.keys()) entry.draining.add(pk);
      await resolveReverseRoutes(entry, pending);
      await drainPendings(entry, pending);
    } finally {
      for (const pk of byPk.keys()) entry.draining.delete(pk);
      // A pending taken and not applied (`appliedPendings`): the kept alias
      // snapshot may miss its change, so its floor is never advanced past it
      // until a whole read rebuilds it. Only a persisted alias advances.
      for (const p of pending) {
        if (!appliedPendings.has(p)) markUnapplied(entry, paramsKey(p.params));
      }
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
    // scoped partial is never persisted (§3.6/§6.7): the non-membership path below is
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
        appliedPendings.add(pendingEntry);
        continue;
      }
      // A membership entry (bounded window / point / the M5 alias) runs the
      // incremental membership path instead of the non-membership FULL branch.
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
      // The non-membership path: a push / invalidate entry, recomputed FULL (`affected`
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
      // D8 — a recompute that changed nothing is not a change. A held-value
      // entry (`holdsValue`: every pushed, non-persisted value) with a held
      // value and subscribers loads BEFORE it mints: when the load equals
      // what every holder holds (`compareHeld`), no version, no frame —
      // only the ack it owes (the cascade still runs). Otherwise it
      // mints after the load, and the frame goes to the subscribers of that
      // moment. (Minting later is safe: a read meanwhile reports the older
      // version, and the frame — to every subscriber registered by then —
      // supersedes it.)
      const holds = holdsValue(entry, persisted);
      // The tracking span this drain started in (`snapshotOwner`'s rule): a
      // held value it records must be the span's own — one that ended while
      // the load ran took its holders with it.
      const span = entry.spans.get(pk);
      const deferMint =
        holds && entry.held.has(pk) && subscribersFor(entry.key, pk).length > 0;
      let version = 0;
      let subs: SocketState[] = [];
      if (!deferMint) {
        version = mintVersion(entry, pk);
        subs = subscribersFor(entry.key, pk);
      }

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
        deferMint ||
        (entry.mode === "push" && subs.length > 0) ||
        hasValueAwareDownstream;
      let value: unknown;
      let raw: unknown;
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
          // `notBefore: lastNotifyAt` — this drain minted (or, deferred, will
          // mint) a version for this change, so a flight that started before
          // the change it is announcing must be superseded rather than joined.
          ({
            value,
            raw,
            watermark: flightWatermark,
            ackTx: flightAckTx,
          } = await (opts.wrapOrigin
            ? opts.wrapOrigin("push", entry.key, () =>
                getResourceValue(
                  entry,
                  params,
                  undefined,
                  undefined,
                  undefined,
                  seedAckTx,
                  pendingEntry.lastNotifyAt,
                ),
              )
            : getResourceValue(
                entry,
                params,
                undefined,
                undefined,
                undefined,
                seedAckTx,
                pendingEntry.lastNotifyAt,
              )));
          valueComputed = true;
        } catch (err) {
          if (evictOnContractError(entry, params, err)) continue;
          reportLoaderError(`loader failed for ${entry.key}`, err);
          // D8: a refused holder sits on an error, not on the held value.
          entry.held.delete(pk);
          broadcastRefusal(
            deferMint ? subscribersFor(entry.key, pk) : subs,
            entry,
            params,
            err,
          );
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
            persistReadSet(entry),
          );
        }
      }

      // D8: what every holder holds — nothing to send, nothing to mint. One
      // comparison (`compareHeld`), whose ops a patched entry's frame reuses.
      const compared = deferMint
        ? compareHeld(entry, pk, value, raw)
        : { unchanged: false };
      const unchanged = compared.unchanged;
      if (unchanged) {
        broadcastAckOnly(entry, pendingEntry);
      } else if (deferMint) {
        version = mintVersion(entry, pk);
        subs = subscribersFor(entry.key, pk);
      }

      // The delivered frame's size (0 while nothing value-carrying was sent) —
      // the `frameChars` measure of this delivery.
      let frameChars = 0;
      if (!unchanged && subs.length > 0) {
        if (entry.mode === "invalidate") {
          const msg = {
            kind: "invalidate" as const,
            key: entry.key,
            params,
            version,
          };
          frameChars = broadcastJson(subs, msg);
        } else {
          // D8: recorded with the subscriber set the frame goes to, before
          // any await — a read served from here on compares against it. Only
          // when that set is every holder: a tab that subscribed while the
          // load ran (a version minted before it) is not in `subs`, and may
          // hold an older read; and only in the span the drain started in.
          if (holds) {
            if (
              entry.spans.get(pk) === span &&
              subscribersFor(entry.key, pk).every((s) => subs.includes(s))
            )
              entry.held.set(pk, heldValue(entry, version, value, raw));
            else entry.held.delete(pk);
          }
          frameChars = await sendUpdate(
            entry,
            params,
            value,
            version,
            subs,
            flightWatermark,
            flightAckTx,
            pendingEntry,
            compared.patch,
          );
        }
      } else if (!unchanged) {
        // D8: a version minted with no frame to every holder — nobody is
        // known to hold anything at it.
        entry.held.delete(pk);
      }

      // Delivery latency (enqueue → ws.send) charged to this resource under the
      // active `flush` entry (server: recordSpan("push", `deliver:<key>`)). Only
      // when a subscriber actually received a frame. Identity no-op on central.
      if (!unchanged && subs.length > 0) {
        opts.onDelivered?.(
          entry.key,
          delivery(pendingEntry, subs.length, frameChars),
        );
      }
      // The churn monitor's hook, as the keyed paths fire it: once per
      // value-carrying recompute for >=1 subscriber — a skipped one is a
      // no-op push (`changed: false`): no frame went out, but the loader ran
      // for nothing, which is the churn the monitor surfaces.
      if (entry.mode === "push") {
        const holders = unchanged
          ? subscribersFor(entry.key, pk).length
          : subs.length;
        if (holders > 0)
          opts.onPush?.(entry.key, {
            subscribers: holders,
            changed: !unchanged,
          });
      }

      // The cascade runs on a skip too, as for any recompute: an unchanged
      // value cannot move a downstream, but a downstream's recompute is its
      // own decision (and its own D8) — a failed one retries on it.
      await cascadeDownstream(
        entry,
        params,
        value,
        valueComputed,
        cascadeSourceTx(pendingEntry),
        pendingEntry.changedAt,
        pendingEntry.heardAt,
      );
    }
  }

  // --- WS handler ---

  const notificationsWsHandler: WsHandler = {
    open(ws) {
      sockets.set(ws, { ws, subs: new Map(), framesSent: 0 });
      // How long owed changes have gone undelivered — every push stopped
      // (`pushStallMs`, 0 when nothing is owed) and one resource's drain
      // stopped (`stalledResources`) — see `pushStall()`. The client reads a
      // ping without them as 0 / none.
      const timer = setInterval(
        () => sendJson(ws, { kind: "ping", ...pushStall() }),
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
        case "address-frames":
          // The peer routes addressed frames (the tabs' SharedWorker): from
          // now on each frame reaches only the tabs it is for.
          state.addressed = true;
          return;
        case "unsub-tab": {
          // Best-effort tab departure (pagehide): release everything this tab
          // holds on this socket. Subs other tabs still hold are untouched.
          const m = msg as ReceivedFrame<"unsub-tab">;
          const tabId = typeof m.tabId === "string" ? m.tabId : "";
          releaseTabSubs(state, tabId);
          releaseDetachedTab(tabId, "unsub-tab");
          return;
        }
      }
    },
    drain(ws) {
      const state = sockets.get(ws);
      if (state) flushBacklog(state);
    },
    close(ws) {
      const timer = heartbeats.get(ws);
      if (timer) clearInterval(timer);
      heartbeats.delete(ws);
      const state = sockets.get(ws);
      sockets.delete(ws);
      if (state) releaseReattachedTabs(state);
      // Its subs linger until their tabs replay them elsewhere (`detached`).
      if (state && state.subs.size > 0) {
        const timer = setTimeout(
          () => releaseDetached(state),
          SOCKET_LINGER_MS,
        );
        (timer as { unref?: () => void }).unref?.();
        detached.set(state, timer);
        lingerLedger.opened(state, tabsOf(state).size, recordCount(state));
      }
    },
  };

  // ── EpochHandoff: resume the version short-circuit across a restart ─────
  //
  // research/2026-10-30-global-cross-boot-resume-epoch-handoff.md. A restart
  // closes every tab's socket and each replays its whole sub set; the version
  // short-circuit cannot answer it (`bootEpoch` is per process), so every
  // tuple reloads. The previous backend hands over what it would have answered
  // `up-to-date` at its shutdown (`handoffState`, taken right after a feed
  // cut), and this one re-proves the gap: a tuple is INHERITED — its echoed
  // version answered `up-to-date` with no load — only when
  //
  //   - the old backend vouched for it at exactly the echoed version (a tuple
  //     a change below the cut reached had a pending, and was left out);
  //   - no change since the cut reached it: the changelog since the cut
  //     replayed through the router (`ResumeRecord.replay`) and every live
  //     change after the shadows were installed — both mark its SHADOW dirty;
  //   - its entry is inheritable here and was there (`inheritable`), under an
  //     EQUAL definition (a deploy that moved the SQL, a decoder, the row
  //     schema or the encode reloads it), every table it reads written to the
  //     changelog (`changelogTables`);
  //   - this process has not served the tuple itself (it would answer from
  //     its own version instead).
  //
  // Anything else — no record, a record that fails to load, history pruned
  // past the cut, a definition mismatch, a dirty shadow, a version mismatch —
  // takes the full path. The failure mode of a wrong proof is a stale value
  // served as `up-to-date` that nothing heals until the next change, so every
  // doubt loads.

  /** One tuple the previous backend vouched for, until a change reaches it. */
  interface Shadow {
    epoch: string;
    pk: string;
    params: ResourceParams;
    version: number;
    dirty: boolean;
  }
  // The live shadows, by key, then `${epoch}\0${pk}`.
  const shadows = new Map<string, Map<string, Shadow>>();
  // Each foreign epoch's resume flight, kept until it expires.
  type ResumeOutcome = { ok: true } | { ok: false; reason: string };
  const resumes = new Map<string, Promise<ResumeOutcome>>();
  // A tuple whose span this process opened at an inherited version, at that
  // version (`tupleSlot`): later echoes of the old epoch keep matching it
  // while it has not changed. Dropped with the span.
  const inherited = new Map<string, number>();
  const tupleSlot = (key: string, pk: string): string => `${key}\u0000${pk}`;
  // How long a resume's shadows wait for the replay to claim them. The herd
  // lands within seconds of the swap; a tab reconnecting later loads.
  const RESUME_WINDOW_MS = 60_000;
  // How long "no record for this epoch" is kept before a sub asks again.
  const NO_RECORD_RETRY_MS = opts.resumeNoRecordRetryMs ?? 2_000;

  // The entry's handoff definition (`RoutePlanInput.handoffDefinition`): its
  // fingerprint, none (the plan carries none, or the compiler found something
  // opaque — with why), or a thunk that threw — a compiler bug, reported.
  // Only a `defined` one is ever inherited.
  type HandoffDefinition =
    HandoffDefinitionAnswer | { kind: "failed"; reason: string };
  // Asked once per routing record (a rebind mints a new one): a thunk that
  // threw is reported once, not on every sub that asks.
  const handoffDefinitions = new WeakMap<RoutingRecord, HandoffDefinition>();
  function handoffDefinitionOf(entry: RegistryEntry): HandoffDefinition {
    const routing = entry.routing;
    const thunk = routing?.plan.handoffDefinition;
    if (routing === undefined || thunk === undefined) {
      return { kind: "none", reason: "not compiled with one" };
    }
    let answer = handoffDefinitions.get(routing);
    if (answer === undefined) {
      try {
        answer = thunk();
      } catch (err) {
        reportLoaderError(`the handoff definition of ${entry.key} threw`, err);
        answer = { kind: "failed", reason: String(err) };
      }
      handoffDefinitions.set(routing, answer);
    }
    return answer;
  }
  // The definition an inheritable entry carries (`inheritable` checked it).
  function definedHandoff(entry: RegistryEntry): string | null {
    const d = handoffDefinitionOf(entry);
    return d.kind === "defined" ? d.definition : null;
  }

  // Whether an entry's tuples can be inherited at all: a routed point read
  // whose definition pins everything its value depends on, every change of it
  // reaching it through its own routes — no drift, no relation or derived
  // read, nothing unfed, notified, tagged or followed, no upstream, no hooks
  // that a load would run — and a version counter that is its complete
  // change signal.
  function inheritable(entry: RegistryEntry): boolean {
    return notInheritable(entry) === null;
  }

  // Why an entry's tuples cannot be inherited (the first reason), or null —
  // `_debug`'s `handoff` per key.
  function notInheritable(entry: RegistryEntry): string | null {
    const routing = entry.routing;
    if (routing === undefined) return "unrouted";
    if (entry.membership?.kind !== "point") return "not-a-point-read";
    const definition = handoffDefinitionOf(entry);
    if (definition.kind !== "defined") {
      return `no definition: ${definition.reason}`;
    }
    if (deferred.has(entry.key)) return "deferred";
    if (entry.externalSource) return "external";
    if (entry.revalidate !== undefined) return "revalidate";
    if (entry.bytes !== undefined) return "bytes";
    if (entry.authorize !== undefined) return "authorize";
    if (entry.onFirstSubscribe !== undefined) return "on-first-subscribe";
    if (entry.onFollowReached !== undefined) return "follows";
    if (entry.upstreamKeys.length > 0) return "upstream";
    if (!versionIsComplete(entry)) return "version-incomplete";
    if (
      routing.drifted.size > 0 ||
      routing.driftBases.size > 0 ||
      routing.seededDrift.size > 0
    ) {
      return "drift";
    }
    if (routing.relationBases.size > 0 || routing.relations.size > 0) {
      return "relation-read";
    }
    if (routing.derived.size > 0) return "derived-read";
    if (routing.unfed.size > 0) return "unfed-read";
    if (routing.notified.size > 0) return "notified-read";
    if (routing.tagged.size > 0) return "tagged-read";
    if (routing.via.size > 0) return "follow-read";
    return null;
  }

  // A tuple is vouched for when this process knows the value its holders hold
  // at `version`: it loaded one (a snapshot), or it inherited one and minted
  // nothing since (`inherited` at the current version — `claimInherited`'s
  // own "still that value" rule; any change since drains FULL and bumps the
  // version). Requiring a snapshot alone left every claimed tuple out, so a
  // backend that booted by inheriting handed its successor nothing it had
  // inherited and every other restart reloaded every point read through the
  // read-admit gate (main, 2026-11-02: 14–30 tuples handed after an
  // inheriting boot vs ~250 otherwise, and 270–370 read-admit waits there).
  function handoffState(): HandoffState {
    const tuples: HandoffTuple[] = [];
    for (const entry of registry.values()) {
      if (!inheritable(entry)) continue;
      const definition = definedHandoff(entry)!;
      for (const [pk, params] of entry.tracked) {
        const version = entry.versions.get(pk) ?? 0;
        if (
          version > 0 &&
          (entry.snapshots?.has(pk) === true ||
            inherited.get(tupleSlot(entry.key, pk)) === version) &&
          !entry.pendingNotifies.has(pk) &&
          !entry.draining.has(pk)
        ) {
          tuples.push({ key: entry.key, pk, params, version, definition });
        }
      }
    }
    return { epoch: bootEpoch, tuples };
  }

  // Whether `change` may reach the shadowed tuple: the router's own rule
  // (`routeTuple`) over the tuple's uses, cut to its own ids — and dirty on
  // every doubt (an unindexed or failed-open table, a `usesOf` that throws or
  // names an unknown route, an unresolved reverse route).
  function shadowReached(
    entry: RegistryEntry,
    params: ResourceParams,
    change: TableChange,
  ): boolean {
    const routing = entry.routing!;
    const routes = routing.byTable.get(change.table);
    if (routes === undefined || routing.driftBases.has(change.table)) {
      return true;
    }
    let outcome: TupleRouting;
    try {
      const uses = routing.plan.usesOf(params);
      for (const id of uses.keys()) {
        if (!routing.routeIds.has(id)) return true;
      }
      outcome = routeTuple(change, routes, uses);
    } catch (err) {
      reportLoaderError(
        `handoff routing failed for ${entry.key} (table "${change.table}")`,
        err,
      );
      return true;
    }
    if (outcome.kind === "untouched") return false;
    if (outcome.kind === "full") return true;
    if (outcome.unresolved.length > 0) return true;
    const membership = entry.membership!;
    const ids = new Set(
      membership.kind === "point" ? membership.idsOf(params) : [],
    );
    for (const set of [outcome.affected, outcome.valueOnly, outcome.deleted]) {
      for (const id of set) if (ids.has(id)) return true;
    }
    return false;
  }

  function markShadows(entry: RegistryEntry, change: TableChange): void {
    const byKey = shadows.get(entry.key);
    if (byKey === undefined) return;
    for (const shadow of byKey.values()) {
      if (!shadow.dirty && shadowReached(entry, shadow.params, change)) {
        shadow.dirty = true;
      }
    }
  }

  // A notify of the tuple (or of the whole key, `{}`) reached its shadows.
  function dirtyShadows(key: string, pk: string): void {
    const byKey = shadows.get(key);
    if (byKey === undefined) return;
    for (const shadow of byKey.values()) {
      if (pk === EMPTY_PK || shadow.pk === pk) shadow.dirty = true;
    }
  }

  // The replay's router: the changelog since the cut, into the shadows only —
  // a tuple this process tracks already loaded after it.
  function routeShadowChange(change: TableChange): void {
    for (const entry of routedByTable.get(change.table) ?? []) {
      markShadows(entry, change);
    }
  }

  function dropShadows(epoch: string): void {
    for (const [key, byKey] of shadows) {
      for (const [slot, shadow] of byKey) {
        if (shadow.epoch === epoch) byKey.delete(slot);
      }
      if (byKey.size === 0) shadows.delete(key);
    }
  }

  function expireResume(epoch: string, ms = RESUME_WINDOW_MS): void {
    const flight = resumes.get(epoch);
    const timer = setTimeout(() => {
      // Only this flight's: a later one under the epoch keeps its own timer.
      if (resumes.get(epoch) !== flight) return;
      resumes.delete(epoch);
      dropShadows(epoch);
    }, ms);
    (timer as { unref?: () => void }).unref?.();
  }

  // One resume per foreign epoch: load its record, shadow every tuple that
  // may be inherited, then replay the gap. A missing record is kept only
  // briefly (a tab that reconnected before the old backend wrote it asks
  // again soon after); every other outcome until it expires. Never rejects:
  // whatever throws is reported and every sub of the epoch loads.
  function resumeFor(epoch: string): Promise<ResumeOutcome> {
    let flight = resumes.get(epoch);
    if (flight === undefined) {
      flight = startResume(epoch);
      resumes.set(epoch, flight);
    }
    return flight;
  }

  async function startResume(epoch: string): Promise<ResumeOutcome> {
    try {
      return await resume(epoch);
    } catch (err) {
      reportLoaderError(`resuming the epoch ${epoch} failed`, err);
      dropShadows(epoch);
      expireResume(epoch);
      return { ok: false, reason: "failed" };
    }
  }

  async function resume(epoch: string): Promise<ResumeOutcome> {
    // One turn first: `resumeFor` stores this flight only once this call
    // returns its promise, and every expiry below matches against it.
    await Promise.resolve();
    let record: ResumeRecord | null;
    try {
      record = await opts.resumeEpoch!(epoch);
    } catch (err) {
      reportLoaderError(`loading the epoch handoff ${epoch} failed`, err);
      expireResume(epoch);
      return { ok: false, reason: "load-failed" };
    }
    if (record === null) {
      expireResume(epoch, NO_RECORD_RETRY_MS);
      return { ok: false, reason: "no-record" };
    }
    // Installed synchronously, BEFORE the replay reads the changelog: a change
    // committed after that read is routed live into them.
    for (const t of record.tuples) {
      const entry = registry.get(t.key);
      if (entry === undefined || !inheritable(entry)) {
        recordResumeRefusal("not-inheritable");
        continue;
      }
      if (definedHandoff(entry) !== t.definition) {
        recordResumeRefusal("definition");
        continue;
      }
      if (
        entry.routing!.plan.routes.some(
          (r) => !record.changelogTables.has(r.table),
        )
      ) {
        recordResumeRefusal("unlogged-table");
        continue;
      }
      const params = canonicalTuple(entry, t.params);
      if (paramsKey(params) !== t.pk) {
        recordResumeRefusal("params");
        continue;
      }
      let byKey = shadows.get(t.key);
      if (byKey === undefined) {
        byKey = new Map();
        shadows.set(t.key, byKey);
      }
      byKey.set(`${epoch}\u0000${t.pk}`, {
        epoch,
        pk: t.pk,
        params,
        version: t.version,
        dirty: false,
      });
    }
    expireResume(epoch);
    let replayed: ResumeReplayOutcome;
    try {
      replayed = await record.replay(routeShadowChange);
    } catch (err) {
      reportLoaderError(`replaying the epoch handoff ${epoch} failed`, err);
      dropShadows(epoch);
      return { ok: false, reason: "replay-failed" };
    }
    if (!replayed.ok) {
      dropShadows(epoch);
      return { ok: false, reason: replayed.reason };
    }
    return { ok: true };
  }

  // Whether a sub echoing a foreign `(epoch, version)` may ask the handoff.
  function asksHandoff(
    entry: RegistryEntry,
    epoch: unknown,
    version: unknown,
  ): epoch is string {
    return (
      opts.resumeEpoch !== undefined &&
      typeof epoch === "string" &&
      epoch !== bootEpoch &&
      typeof version === "number" &&
      inheritable(entry)
    );
  }

  // The claim, once `epoch`'s resume settled: the version to answer
  // `up-to-date` at, or why the tuple loads. Synchronous, so nothing can land
  // between the checks and the version it sets.
  function claimInherited(
    entry: RegistryEntry,
    pk: string,
    epoch: string,
    version: number,
    outcome: ResumeOutcome,
  ): { ok: true; version: number } | { ok: false; reason: string } {
    if (!outcome.ok) return outcome;
    if (!inheritable(entry)) return { ok: false, reason: "not-inheritable" };
    const shadow = shadows.get(entry.key)?.get(`${epoch}\u0000${pk}`);
    if (shadow === undefined) return { ok: false, reason: "not-handed-over" };
    if (shadow.dirty) return { ok: false, reason: "changed" };
    if (shadow.version !== version) return { ok: false, reason: "version" };
    if ((entry.subCounts.get(pk) ?? 0) === 0) {
      return { ok: false, reason: "unsubscribed" };
    }
    const current = entry.versions.get(pk);
    const slot = tupleSlot(entry.key, pk);
    const at = inherited.get(slot);
    if (at !== undefined) {
      // Inherited by an earlier claim: still that value while nothing minted.
      return at === current
        ? { ok: true, version: current }
        : { ok: false, reason: "changed-here" };
    }
    // Fresh here: the only version this process minted for the tuple is the
    // opener of its span (`spans` holds it), and nothing loaded, queued or
    // drained it since — so this process has no value of its own for it.
    if (
      current !== entry.spans.get(pk) ||
      entry.snapshots?.has(pk) === true ||
      entry.pendingNotifies.has(pk) ||
      entry.draining.has(pk)
    ) {
      return { ok: false, reason: "served-here" };
    }
    entry.versions.set(pk, version);
    // Every later mint must land above the adopted version (another boot's
    // clock), or the tuple's version would go backwards.
    versionClock = Math.max(versionClock, version);
    inherited.set(slot, version);
    return { ok: true, version };
  }

  function recordResumed(key: string): void {
    resumedSubs.set(key, (resumedSubs.get(key) ?? 0) + 1);
  }

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
      rec = {
        params,
        tabs: new Set<string>(),
        ackTabs: new Set<string>(),
        awaiting: new Set<string>(),
      };
      inner.set(pk, rec);
    }
    rec.tabs.add(tabId);
    rec.awaiting.add(tabId);
    if (acks) rec.ackTabs.add(tabId);
    else rec.ackTabs.delete(tabId);
    if (alreadyHeldBySocket) return { firstGlobal: false };
    const prev = entry.subCounts.get(pk) ?? 0;
    entry.subCounts.set(pk, prev + 1);
    if (prev === 0) {
      entry.tracked.set(pk, params);
      entry.spans.set(pk, mintVersion(entry, pk));
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
      if (entry.versions.get(spk) !== s.version) return "source-moved";
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

  // A tuple's 0→1 hook (`onFirstSubscribe`, a `whileSubscribed` watcher
  // start), settled before its first read — so the sub-ack waits on it. Run
  // as its own `sub` span, `start:<key>`: a slow watcher start is then a
  // timed op of its own, not untimed time before the gated read. A failure is
  // reported and the read goes on.
  async function startFirstSubscribe(
    entry: RegistryEntry,
    params: ResourceParams,
  ): Promise<void> {
    const hook = entry.onFirstSubscribe;
    if (!hook) return;
    const run = async (): Promise<void> => {
      await hook(params);
    };
    try {
      await (opts.wrapOrigin
        ? opts.wrapOrigin("sub", `start:${entry.key}`, run)
        : run());
    } catch (err) {
      reportLoaderError(`onFirstSubscribe failed for ${entry.key}`, err);
    }
  }

  // `m.derive` is a seeded derivation (see `deriveSub`), on a fresh `sub`
  // only, read only under this server's `PROTOCOL` (`m.protocol`).
  async function handleSub(
    state: SocketState,
    m: ReceivedFrame<"sub">,
  ): Promise<void> {
    const { key, params = {}, etag: clientEtag } = m;
    if (!key) return;
    const req = subRequestOf(m);
    const build = typeof m.build === "string" ? m.build : undefined;
    noteClientBuild(build);
    const entry = registry.get(key);
    if (!entry) {
      sendJson(state.ws, {
        kind: "sub-error",
        ...req,
        key,
        params,
        ...refuseUnknownKey(key, build),
      });
      return;
    }
    // The params gate — before authorize and before the sub registers, so a
    // refused sub leaves no trace a push could rerun.
    if (refuseSubParams(state.ws, entry, req, params, build)) return;
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
          ...req,
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
      req.tabId ?? "",
      m.acks === true,
    );
    // Where in this socket's frame stream the sub registered (`alreadyShipped`):
    // from here on every frame of the tuple is addressed to this tab too — a
    // frame sent while `authorize` was awaited before it was not.
    const arrivedAt = state.framesSent;
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
          ...req,
          key,
          params,
          version: versionOf(entry, pk),
          ...ackIdentity(),
          derived: outcome,
        });
      }
    }
    if (firstGlobal && entry.onFirstSubscribe)
      await startFirstSubscribe(entry, params);
    if (derived) return;

    // Version short-circuit: the client echoed the (epoch, version) its cached
    // value was produced under. If the epoch is THIS boot and the version equals
    // the current per-pk counter, nothing changed since that value shipped — for
    // a `versionIsComplete` resource the version counter is its complete change
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
    //   - resources whose version counter is complete (`versionIsComplete`):
    //     every non-`revalidate` one, and a `revalidate` one declared
    //     `notified` — its notify stream is its whole change signal, so its
    //     ETag only has to answer what the counter cannot: a replay from
    //     another boot. An undeclared `revalidate` resource's truth may live
    //     outside any notify stream (git), so its ETag stays the authority.
    // The HTTP path (`handleResourceHttp`) deliberately has NO version
    // short-circuit: the invalidate-mode refetch must return a body at an equal
    // version (the client's strict-`<` HTTP guard accepts it). That HTTP body
    // carries `epoch: bootEpoch` alongside the version, so the client can tell a
    // fresh same-boot body apart from a stale-boot cache — the epoch-aware guard
    // that fixes the cross-boot cache-poisoning drop (Fix B).
    const currentVersion = entry.versions.get(pk);
    if (
      !firstGlobal &&
      versionIsComplete(entry) &&
      m.epoch === bootEpoch &&
      typeof m.version === "number" &&
      m.version === currentVersion
    ) {
      sendJson(state.ws, {
        kind: "up-to-date",
        ...req,
        key,
        params,
        version: m.version,
        ...ackIdentity(),
      });
      recordSubShortCircuit(key);
      return;
    }

    // An echo of ANOTHER boot's version: the epoch handoff may answer it
    // (`EpochHandoff`) — anything it cannot prove loads below.
    if (asksHandoff(entry, m.epoch, m.version)) {
      const claim = claimInherited(
        entry,
        pk,
        m.epoch,
        m.version as number,
        await resumeFor(m.epoch),
      );
      if (claim.ok) {
        sendJson(state.ws, {
          kind: "up-to-date",
          ...req,
          key,
          params,
          version: claim.version,
          ...ackIdentity(),
        });
        recordResumed(key);
        return;
      }
      recordResumeRefusal(claim.reason);
    }

    await serveSub(
      state,
      entry,
      req,
      key,
      params,
      pk,
      clientEtag,
      firstGlobal,
      arrivedAt,
    );
  }

  // Answer a sub the socket's own frames already answered (`alreadyShipped`)
  // with `up-to-date` at the version the socket holds instead of the whole
  // value again. Returns whether it did.
  function answerShipped(
    state: SocketState,
    req: SubRequest,
    key: string,
    params: ResourceParams,
    pk: string,
    arrivedAt: number,
    version: number,
  ): boolean {
    const shipped = alreadyShipped(
      state,
      key,
      pk,
      arrivedAt,
      version,
      req.tabId ?? "",
    );
    if (shipped === null) return false;
    sendJson(state.ws, {
      kind: "up-to-date",
      ...req,
      key,
      params,
      version: shipped.version,
      ...ackIdentity(),
    });
    subAcksShared.set(key, (subAcksShared.get(key) ?? 0) + 1);
    subAckCharsSaved.set(key, (subAckCharsSaved.get(key) ?? 0) + shipped.chars);
    return true;
  }

  // The read/serve tail of a subscription: probe the conditional-revalidation
  // signature, run the gated full load, seed the keyed snapshot, and send the
  // sub-ack. Shared by `handleSub` and `handleSubBatch`'s full-path entries.
  // Callers have already registered the sub and settled `onFirstSubscribe`.
  async function serveSub(
    state: SocketState,
    entry: RegistryEntry,
    req: SubRequest,
    key: string,
    params: ResourceParams,
    pk: string,
    clientEtag: string | undefined,
    opensSpan: boolean,
    arrivedAt: number,
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
    const version = versionOf(entry, pk);

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
    let freshEtag: string | undefined;
    try {
      freshEtag = entry.revalidate
        ? await computeEtag(entry, params, "sub")
        : undefined;
    } catch (err) {
      if (!(err instanceof ReadAbandoned)) throw err;
      recordAbandonedRead(key);
      return;
    }
    if (
      freshEtag !== undefined &&
      clientEtag != null &&
      freshEtag === clientEtag
    ) {
      // D8: the client keeps a value of its own, which no object here names.
      noteRead(entry, pk, undefined);
      sendJson(state.ws, {
        kind: "up-to-date",
        ...req,
        key,
        params,
        version,
        ...ackIdentity(),
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
        ...req,
        key,
        params,
        version,
        ...ackIdentity(),
      });
      return;
    }

    // A PATCHED value with a base: the value every holder holds, at its
    // version — so this holder can apply the next patch like the others. A
    // change since is a notify already pending: its drain patches it forward.
    const patchBase = entry.patches ? entry.held.get(pk) : undefined;
    if (patchBase !== undefined) {
      if (
        answerShipped(state, req, key, params, pk, arrivedAt, patchBase.version)
      )
        return;
      noteSubAckChars(
        key,
        sendJson(state.ws, {
          kind: "sub-ack",
          ...req,
          key,
          params,
          value: patchBase.value,
          version: patchBase.version,
          ...ackIdentity(),
        }),
      );
      return;
    }

    let value: unknown;
    let raw: unknown;
    let etag: string | undefined;
    let watermark: string | undefined;
    // How much of the read awaited another run already in flight (a push's
    // flight it coalesced onto, a shared memo's pass): that run's time, which
    // its own span is judged on. The sub-ack carries it so the browser's
    // mount → first data (`element`) is not judged on it again.
    let joinedMs = 0;
    try {
      // Origin = the subscription: establishes an entry context so the loader
      // span (and any gate waits it charges) is attributed to this `sub` request
      // instead of running with `parent: null`. Gated by the read-admission cap.
      ({ value, raw, etag, watermark } = await gatedRead(
        entry,
        params,
        "sub",
        freshEtag,
        (ms) => {
          joinedMs = ms;
        },
      ));
    } catch (err) {
      // Every holder of the tuple left while this read queued: nobody to
      // answer, and nothing was loaded.
      if (err instanceof ReadAbandoned) {
        recordAbandonedRead(key);
        return;
      }
      // A gate gap: the tuple is registered, so evict it everywhere (which
      // tells this socket too) rather than leave every push re-failing.
      if (evictOnContractError(entry, params, err, { state, req })) return;
      reportLoaderError(`loader failed for ${key}`, err);
      noteRead(entry, pk, undefined); // D8: this holder now sits on an error
      sendJson(
        state.ws,
        err instanceof ResourceRefusal
          ? {
              kind: "sub-error",
              ...req,
              key,
              params,
              reason: "refused",
              code: err.code,
              message: err.message,
            }
          : { kind: "sub-error", ...req, key, params, reason: "loader-failed" },
      );
      return;
    }
    // Yield ONCE before touching the snapshot or the wire. A push continuation
    // parked on the SAME coalesced flight attached after this read, so it
    // resumes one job later; it must still run first — it sends its update
    // frame synchronously (H5a: a push beats a racing parked sub-ack) and, for
    // keyed mode, performs the first diffKeyed (no snapshot yet → FULL update)
    // before this sub-ack's seed below, which then finds a snapshot and keeps it (H5c). Before
    // gate-after-dedup the starter paid these hops implicitly in the
    // read-admission slot release chain; with the gate now inside the
    // single-flight, the yield is the explicit, pinned equivalent.
    await Promise.resolve();
    // Keyed entries: seed the per-pk snapshot from the full sub-ack value so the
    // next notify can diff against it. The sub-ack itself stays full-value.
    // ONLY when the tuple has none: a held snapshot is the base every earlier
    // holder was served, and this read may be NEWER than it as well as older —
    // older when a push advanced the snapshot since the flight began (H5c),
    // NEWER when it ran after a commit whose NOTIFY has not drained yet. An
    // older base would lose a change for good (the router reads membership off
    // it, and a value-role change to a host the base lacks is dropped as a
    // non-member's); a newer one, at the same version, absorbs the commit — its
    // drain diffs to nothing, ships an ack, and the earlier holders, who drop
    // this sub-ack as not newer than what they hold, never receive the row
    // (runtime-reseed-ahead.test.ts: the queue's Unranked conversation). Kept,
    // the base can only lag this read, which costs this holder a redundant row
    // on the next delta, never a missing one.
    //
    // Nor while the tuple's span was opened by an epoch-handoff claim with no
    // snapshot behind it (`inherited`): its holders hold the value of the
    // previous backend's cut, so a base seeded from this NEWER read would
    // absorb a change still in flight to them in the same way. Left without
    // one, the next change drains FULL and ships to every holder.
    if (entry.mode === "keyed") {
      const snapshots = (entry.snapshots ??= new Map());
      if (!snapshots.has(pk) && !inherited.has(tupleSlot(entry.key, pk))) {
        snapshots.set(pk, snapshotOf(entry, value));
        reseedOrderSigs(entry, params, value); // lifecycle mirrors the snapshot seed
        // The new base's floor is the flight's own watermark (C19): the value
        // this snapshot now holds reflects every commit below it.
        setBaseFloor(entry, pk, watermark);
        markRebuilt(entry, pk);
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
    noteRead(
      entry,
      pk,
      { value, raw },
      opensSpan ? { state, version } : undefined,
    );
    if (answerShipped(state, req, key, params, pk, arrivedAt, version)) return;
    noteSubAckChars(
      key,
      sendJson(state.ws, {
        kind: "sub-ack",
        ...req,
        key,
        params,
        value,
        version,
        ...(etag !== undefined ? { etag } : {}),
        ...(watermark !== undefined ? { watermark } : {}),
        ...(joinedMs >= 1 ? { joinedMs: Math.round(joinedMs) } : {}),
        ...ackIdentity(),
      }),
    );
  }

  function noteSubAckChars(key: string, chars: number): void {
    subAckChars.set(key, (subAckChars.get(key) ?? 0) + chars);
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
    noteClientBuild(build);
    const entries = Array.isArray(m.entries) ? m.entries : [];
    // Where in this socket's frame stream the batch arrived (`alreadyShipped`).
    const arrivedAt = state.framesSent;

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
          tabId,
          key: e.key,
          params,
          ...refuseUnknownKey(e.key, build),
        });
        continue;
      }
      if (refuseSubParams(state.ws, entry, { id: e.id, tabId }, params, build))
        continue;
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
      // …and everything it still held on a closed socket: what it restated is
      // held here now (registered above, so it never went through 0 — the
      // short-circuit below can answer it), the rest it no longer wants.
      releaseDetachedTab(tabId, "replayed");
      lingerLedger.returned(tabId);
    }

    // Pass 2 — synchronous short-circuit collection; everything else detaches
    // onto the full serve path.
    const upToDate: Array<{
      id?: number;
      key: string;
      params: ResourceParams;
      version: number;
    }> = [];
    // Entries echoing another boot's version the epoch handoff may answer.
    const claims: typeof prepared = [];
    for (const p of prepared) {
      const version = p.entry.versions.get(p.pk);
      if (
        !p.firstGlobal &&
        versionIsComplete(p.entry) &&
        m.epoch === bootEpoch &&
        typeof p.version === "number" &&
        p.version === version
      ) {
        // Same short-circuit as `handleSub`, collected into one batch frame.
        // Never a 0→1 entry: its registration opened a tracking span, so it —
        // and its `onFirstSubscribe` — always takes the full path below.
        recordSubShortCircuit(p.key);
        upToDate.push({
          id: p.id,
          key: p.key,
          params: p.params,
          version: p.version,
        });
        continue;
      }
      if (asksHandoff(p.entry, m.epoch, p.version)) {
        claims.push(p);
        continue;
      }
      void (async () => {
        // Mirror handleSub's ordering: settle the 0→1 hook before the read.
        if (p.firstGlobal && p.entry.onFirstSubscribe)
          await startFirstSubscribe(p.entry, p.params);
        await serveSub(
          state,
          p.entry,
          { id: p.id, tabId },
          p.key,
          p.params,
          p.pk,
          p.etag,
          p.firstGlobal,
          arrivedAt,
        );
      })();
    }
    if (upToDate.length > 0) {
      sendJson(state.ws, {
        kind: "up-to-date-batch",
        ...ackIdentity(),
        tabId,
        entries: upToDate,
      });
    }
    // The handoff's claims, answered as one batch once the epoch's resume
    // settled; each one it cannot prove takes the full path (an inheritable
    // entry has no `onFirstSubscribe` to settle first).
    if (claims.length > 0) {
      const epoch = m.epoch as string;
      void (async () => {
        const outcome = await resumeFor(epoch);
        const answered: typeof upToDate = [];
        for (const c of claims) {
          const claim = claimInherited(
            c.entry,
            c.pk,
            epoch,
            c.version!,
            outcome,
          );
          if (claim.ok) {
            recordResumed(c.key);
            answered.push({
              id: c.id,
              key: c.key,
              params: c.params,
              version: claim.version,
            });
            continue;
          }
          recordResumeRefusal(claim.reason);
          void serveSub(
            state,
            c.entry,
            { id: c.id, tabId },
            c.key,
            c.params,
            c.pk,
            c.etag,
            c.firstGlobal,
            arrivedAt,
          );
        }
        if (answered.length > 0) {
          sendJson(state.ws, {
            kind: "up-to-date-batch",
            ...ackIdentity(),
            tabId,
            entries: answered,
          });
        }
      })();
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
    rec.awaiting.delete(tabId);
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
    // A lingering socket holds it too; nobody there to tell.
    for (const state of detached.keys()) unregisterSubOnSocket(state, key, pk);
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
        rec.awaiting.delete(tabId);
        if (rec.tabs.size > 0) continue;
        inner.delete(pk);
        releaseSubRefcount(key, pk, rec.params);
      }
      if (inner.size === 0) state.subs.delete(key);
    }
  }

  // A lingering socket's bound passed: release whatever its tabs did not
  // replay elsewhere, once per (key, pk) regardless of how many tabs held it —
  // the socket-level refcount was bumped once per pk. Legacy `""`-bucket subs
  // release here too (their only teardown path).
  function releaseDetached(state: SocketState): void {
    const timer = detached.get(state);
    if (timer === undefined) return;
    clearTimeout(timer);
    detached.delete(state);
    lingerLedger.ended(state, "expired", {
      records: recordCount(state),
      tabs: tabsOf(state),
    });
    for (const [key, inner] of state.subs) {
      for (const [pk, rec] of inner) releaseSubRefcount(key, pk, rec.params);
    }
    state.subs.clear();
  }

  // A closing socket's tabs that already hold subs on a live socket: their
  // replay landed before this close (a reconnect raced it), so what they want
  // is held there — release their records here at once rather than at the
  // linger's end. Releasing early can only cost a reload, never a stale answer.
  function releaseReattachedTabs(closing: SocketState): void {
    const live = new Set<string>();
    for (const st of sockets.values()) {
      for (const tab of tabsOf(st)) live.add(tab);
    }
    for (const tab of tabsOf(closing)) {
      if (live.has(tab)) releaseTabSubs(closing, tab);
    }
  }

  // The tabs holding subs on a socket.
  function tabsOf(state: SocketState): Set<string> {
    const tabs = new Set<string>();
    for (const inner of state.subs.values()) {
      for (const rec of inner.values()) {
        for (const tab of rec.tabs) tabs.add(tab);
      }
    }
    return tabs;
  }

  // The (key, pk) records a socket holds.
  function recordCount(state: SocketState): number {
    let n = 0;
    for (const inner of state.subs.values()) n += inner.size;
    return n;
  }

  // `tabId` replayed or left: release what it held on every lingering socket,
  // and drop a socket nothing is left on.
  function releaseDetachedTab(
    tabId: string,
    by: Exclude<LingerEnd, "expired">,
  ): void {
    for (const [state, timer] of detached) {
      releaseTabSubs(state, tabId);
      if (state.subs.size === 0) {
        clearTimeout(timer);
        detached.delete(state);
        lingerLedger.ended(state, by);
      }
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
      inherited.delete(tupleSlot(key, pk));
      // The tuple leaves the router's targets, and its memoized read-set with it.
      entry.tracked.delete(pk);
      entry.spans.delete(pk);
      // The version dies with its span: the clock never hands it out again,
      // so a tab still holding it can match no later span (`versionClock`).
      entry.versions.delete(pk);
      entry.held.delete(pk);
      entry.routing?.uses.delete(pk);
      entry.routing?.loaded.delete(pk);
      entry.routing?.followHeld.delete(pk);
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
    noteClientBuild(build);
    if (!key) return httpError(404, { reason: "unknown-key" });
    if (key === "_debug") return handleResourcesDebug();
    const entry = registry.get(key);
    if (!entry) return httpError(404, refuseUnknownKey(key, build));
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
      ? await computeEtag(entry, resourceParams, "http")
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
      noteRead(entry, paramsKey(resourceParams), undefined); // D8: no body
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
    const version = versionOf(entry, pk);

    let value: unknown;
    let raw: unknown;
    let etag: string | undefined;
    let watermark: string | undefined;
    try {
      // Same-flight co-production, exactly as `handleSub` (read its comment for the
      // full argument): `freshEtag` SEEDS the flight; the flight hands back the etag
      // it was actually seeded with, which is the caller's own only if this call
      // started it. A joiner adopts the starter's older seed, or `undefined` when a
      // push-path caller started the flight.
      ({ value, raw, etag, watermark } = await gatedRead(
        entry,
        resourceParams,
        "http",
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
      noteRead(entry, pk, undefined); // D8: the reader may be a holder on an error
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
    // D8: an HTTP reader is no identified holder — it may only keep (equal
    // content) or clear.
    noteRead(entry, pk, { value, raw });
    // A BYTES value's body IS the value (`application/octet-stream`); the rest of
    // the envelope below — version, epoch, watermark, which the client's guard
    // needs exactly as for a JSON body — rides response headers instead.
    if (entry.bytes === true) {
      return new Response(value as ArrayBuffer, {
        headers: {
          ...headers,
          ...resourceBytesHeaders({
            version,
            ...bootIdentity(),
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
        ...bootIdentity(),
        ...(watermark !== undefined ? { watermark } : {}),
      }),
      { headers },
    );
  }

  // A7 / D40: what an entry IS, as one closed set, checked in this order — a
  // deferred placeholder not bound yet (`unbound`: no loader, no routes), truth
  // outside Postgres (`external`: declared via `defineExternalResource`, so its
  // own `notify` reaches it), compiler-emitted routes (`routed`:
  // `routeTableChange`), and otherwise `unrouted` — reached by no table change,
  // which change-feed refuses at boot (D6, `unroutedResourceKeys`), so only a
  // DB-free harness ever shows one. An external may ALSO be reached by its
  // declared reads (`routes` non-null) — the policy is what it is, `routes`
  // how a table change reaches it.
  function debugPolicyOf(entry: RegistryEntry): DebugPolicy {
    if (deferred.has(entry.key)) return "unbound";
    if (entry.externalSource) return "external";
    if (entry.routing) return "routed";
    return "unrouted";
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
      routes: Array<{
        id: string;
        table: string;
        map: HostMap["kind"];
        reason?: string;
      }> | null;
      derivedReads: string[];
      unfedReads: string[];
      relationReads: Array<{
        relation: string;
        reason: string;
        bases: string[];
      }>;
      notifiedReads: Array<{ relation: string; reason: string }>;
      follows: Array<{ name: string; collection: string }>;
      followRepoints: number;
      followHeldHits: number;
      followHeldDrops: number;
      routeDrifted: string[];
      routeDriftSeeded: string[];
      tuples: number;
      persisted: boolean;
      positionAgeMs: number | null;
      loaderStats?: { count: number; ratePerMin: number; maxMs: number };
      notifyStats: NotifyCounts;
      subShortCircuits: number;
      abandonedReads: number;
      sharedProbes: number;
      pointBatches: { runs: number; joined: number };
      handoff: string;
      resumedSubs: number;
      staleFlightSupersedes: number;
      replaySkips: number;
      ackOverflows: number;
      derivedSubs: number;
      subAcksShared: number;
      subAckChars: number;
      subAckCharsSaved: number;
      deriveFallbacks: Partial<Record<DeriveRefusal, number>>;
      subTabs: Record<string, number>;
      externalSource: boolean;
      freshness: ResourceFreshness | null;
      shape: ResourceListShape | null;
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
      // read) and its relation bases (views and rollups expanded to the base
      // tables feeding them) — display only, no change routes through them.
      // Unfiltered: a rollup shows in the raw set, its sources in
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
        // A routed entry's routes (null = no table change reaches it — an
        // external reached only by its own notify, or an unrouted entry):
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
        // guard judged them. `[]` for an entry with no routing (and on central).
        derivedReads: entry.routing ? [...entry.routing.derived].sort() : [],
        // A reach plan's tables read outside the change feed by declaration
        // (`ReachPlan.unfed`). `[]` otherwise.
        unfedReads: entry.routing ? [...entry.routing.unfed].sort() : [],
        // A reach plan's relation reads (`ReachPlan.relations`): each view or
        // rollup read whole, its reason, and the bases a write to which
        // reaches the entry (`indexRelationReads`). `[]` otherwise.
        relationReads: entry.routing
          ? [...entry.routing.relations]
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([relation, reason]) => ({
                relation,
                reason,
                bases: [...relationBasesOf(relation)].sort(),
              }))
          : [],
        // A reach plan's notified reads (`ReachPlan.notified`): relations an
        // external entry's own notify covers, never routed. `[]` otherwise.
        notifiedReads: entry.routing
          ? [...entry.routing.notified]
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([relation, reason]) => ({ relation, reason }))
          : [],
        // A reach plan's follows (`Route.via`): each collection it reads a
        // tuple of, by follow name, and how many times a followed change
        // re-pointed its `whileFollowing` start (`onFollowReached`).
        follows: entry.routing ? followsOf(entry.routing) : [],
        followRepoints: followRepoints.get(entry.key) ?? 0,
        // Follow reads served from the tuple's held rows, and held reads a
        // change through the follow dropped (`HeldFollows`).
        followHeldHits: followHeldHits.get(entry.key) ?? 0,
        followHeldDrops: followHeldDrops.get(entry.key) ?? 0,
        routeDrifted: entry.routing ? [...entry.routing.drifted].sort() : [],
        // D7: persisted reads seeded as drift at boot that no load has
        // confirmed yet (`seedRouteDrift`) — routed FULL, not reported.
        routeDriftSeeded: entry.routing
          ? [...entry.routing.seededDrift].sort()
          : [],
        // Tracked params-tuples (`entry.tracked`): the subscribed tuples a
        // change recomputes — a FULL-routed entry's fan-out per change.
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
        // Reads skipped at the read-admission gate because every subscriber
        // of the tuple left while they queued (see `ReadAbandoned`).
        abandonedReads: abandonedReads.get(entry.key) ?? 0,
        // `revalidate` probes that shared another queued probe's signature
        // read (no slot, no read; see `computeEtag`).
        sharedProbes: sharedProbes.get(entry.key) ?? 0,
        // Batched cold point reads (`PointBatch`): loads run through a batch,
        // and reads that rode one another tuple opened (no slot, no query).
        pointBatches: pointBatchStats.get(entry.key) ?? { runs: 0, joined: 0 },
        handoff: notInheritable(entry) ?? "inheritable",
        resumedSubs: resumedSubs.get(entry.key) ?? 0,
        // Stale-flight supersessions for this key (a push drain refused an
        // in-flight read older than the notify it was draining, and ran its
        // own). Non-zero means the pre-commit join that produced the 2026-08-08
        // revert is still reachable under load — and is now refused instead of
        // broadcast under a fresh version.
        staleFlightSupersedes: staleFlightSupersedes.get(entry.key) ?? 0,
        // Boot catch-up rows this key's `{}` skipped as already reflected in
        // its L2 row (see `replayReflected`).
        replaySkips: replaySkips.get(entry.key) ?? 0,
        // Drained tuple-cycles whose ackTx was suppressed by the sourceTx cap
        // (see `recordAckOverflow`).
        ackOverflows: ackOverflows.get(entry.key) ?? 0,
        // Seeded derivations for this key (see `deriveSub`): subs answered
        // from rows the client held, and the ones that fell back to a load —
        // by reason.
        derivedSubs: derivedSubs.get(entry.key) ?? 0,
        // Replayed subs answered by another tab's frame on the same socket
        // (`answerShipped`), and the chars of value sub-acks sent.
        subAcksShared: subAcksShared.get(entry.key) ?? 0,
        subAckChars: subAckChars.get(entry.key) ?? 0,
        subAckCharsSaved: subAckCharsSaved.get(entry.key) ?? 0,
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
        // The declared shape of a value's lists (`null`: none declared — a
        // collection's resources, or one not declared through `liveValue`).
        shape: entry.shape ?? null,
        // L2 bookkeeping, for a persisted key only: its definition (A18), when
        // this process last replaced / floor-wrote its row, and the row's
        // `position_at` as last known (epoch ms; null = never in this process).
        ...(persisted
          ? {
              definition: definitionOf(entry),
              lastReplaceAt: persistStats.get(entry.key)?.lastReplaceAt ?? null,
              lastFloorAt: persistStats.get(entry.key)?.lastFloorAt ?? null,
              // The last floor persist that RAISED the row's position to a
              // routed cut, and why the others did not (by reason).
              lastAdvanceAt: persistStats.get(entry.key)?.lastAdvanceAt ?? null,
              advanceRefusals: Object.fromEntries(
                persistStats.get(entry.key)?.advanceRefusals ?? [],
              ),
              advanceRefusal: advanceRefusal(entry),
              l2PositionAt: l2PositionAt ?? null,
            }
          : {}),
      });
    }
    return new Response(
      JSON.stringify(
        {
          topoOrder: topoOrder.map((e) => e.key),
          // The epoch handoff (`EpochHandoff`): why a foreign echo loaded,
          // and how many shadows are still waiting to be claimed.
          resume: {
            refusals: Object.fromEntries(resumeRefusals),
            shadows: [...shadows.values()].reduce((n, m) => n + m.size, 0),
          },
          // Closed sockets whose subs still linger (`detached`), the
          // (key, pk) records they hold, and what every linger did
          // (`linger-ledger.ts`): how each ended, after how long awake and
          // asleep, and the tabs that came back after theirs expired.
          linger: {
            sockets: detached.size,
            records: [...detached.keys()].reduce(
              (n, st) => n + recordCount(st),
              0,
            ),
            ...lingerLedger.snapshot(),
          },
          resources: out,
        },
        null,
        2,
      ),
      { headers: { "content-type": "application/json" } },
    );
  }

  // Load any registered resource by key through the same `timedLoad` path
  // `handleSub` uses (schema parse + profiler span). Throws on an unknown key.
  // A plan's follows, one per name, sorted (`_debug`).
  function followsOf(
    routing: RoutingRecord,
  ): Array<{ name: string; collection: string }> {
    const byName = new Map<string, string>();
    for (const route of routing.plan.routes) {
      if (route.via) byName.set(route.via.name, route.via.collection);
    }
    return [...byName]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, collection]) => ({ name, collection }));
  }

  // A tuple's value read FRESH (see the interface): the entry's own loader
  // through `timedLoad` — its loader span, schema parse and drift guard —
  // and nothing else: no flight (joining one could hand back a read that
  // began before the caller's change), no watermark, no tracking state.
  async function loadResourceFresh(
    key: string,
    params: ResourceParams,
  ): Promise<unknown> {
    const entry = registry.get(key);
    if (!entry) throw new Error(`unknown resource key: ${key}`);
    if (deferred.has(key)) {
      throw new Error(
        `loadResourceFresh: "${key}" is deferred and not bound yet — nothing reads it before bindDeferredResources`,
      );
    }
    const tuple = canonicalTuple(entry, params);
    entry.validateParams(tuple);
    return timedLoad(entry, tuple);
  }

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

  // Distinct currently-subscribed params tuples for a resource key: its
  // tracked tuples — a lingering socket's included (`detached`), which is what
  // keeps a change in a reconnect's gap reaching the tuples the replay will ask.
  function subscribedParamsFor(key: string): ResourceParams[] {
    const entry = registry.get(key);
    return entry === undefined ? [] : [...entry.tracked.values()];
  }

  // --- Scoped change routing (routed entries) ---

  // Route one base-table change to every ROUTED entry reading the table (see
  // `ResourceRuntime.routeTableChange` and `./routing`). Synchronous: each tuple's
  // pending is merged in this call, so the whole change rides one flush.
  // Defensive: a failure is reported, never thrown at the producer — and isolated per entry (per tuple inside `routeEntryChange`), so
  // one failing entry cannot take the change from the others.
  function routeTableChange(change: TableChange, replay?: ReplayScope): void {
    for (const entry of routedByTable.get(change.table) ?? []) {
      try {
        // Every change — a catch-up replay's too — reaches the handed-over
        // state (over-marking only costs a load).
        markShadows(entry, change);
        routeEntryChange(entry, change, replay);
      } catch (err) {
        reportLoaderError(
          `routeTableChange failed for ${entry.key} (table "${change.table}")`,
          err,
        );
        // The change may not have reached every tuple it should: none of the
        // entry's kept snapshots can be proven to hold it.
        for (const pk of entry.snapshots?.keys() ?? [])
          markUnapplied(entry, pk);
      }
    }
  }

  // One routed entry, every tuple it must consider: its subscribed tuples
  // (`tracked` — never an O(sockets) scan), plus `{}` for a persisted entry,
  // which keeps its value current with nobody subscribed — and, with NO tuple
  // subscribed, for an entry with downstream edges whose `{}` is a tuple of
  // it: that drain is what cascades the change on to its downstreams. A param'd
  // window or point set with no subscriber has nobody to keep current, so it
  // gets nothing: a fresh subscribe loads from scratch.
  function routedTargets(
    entry: RegistryEntry,
    replay?: ReplayScope,
  ): [pk: string, params: ResourceParams][] {
    const targets = [...entry.tracked];
    if (replay !== undefined && replayReflected(entry, replay)) {
      // The `{}` tuple's value already reflects this replayed change (see
      // `replayReflected`): drop it, whether or not a tab subscribed to it —
      // any value it holds was read at or after its L2 floor.
      const i = targets.findIndex(([pk]) => pk === EMPTY_PK);
      if (i !== -1) targets.splice(i, 1);
      replaySkips.set(entry.key, (replaySkips.get(entry.key) ?? 0) + 1);
      return targets;
    }
    if (
      !entry.tracked.has(EMPTY_PK) &&
      (isPersisted(entry) ||
        (entry.tracked.size === 0 &&
          entry.downstream.length > 0 &&
          acceptsEmptyTuple(entry)))
    ) {
      targets.push([EMPTY_PK, {}]);
    }
    return targets;
  }

  // Whether a replayed change (`ReplayScope`) is already reflected in a
  // PERSISTED entry's `{}` value: its xid is below the entry's L2 floor — the
  // xmin of the read the row's value came from, so every lower transaction had
  // finished before it. A key with no floor (recomputed at boot, no usable row)
  // is never proven current, so the change routes. No downstream can miss it
  // through the skip: a persisted entry is never external, and every
  // `dependsOn` upstream is (T15), so a persisted entry cascades to nothing.
  // Per key: replayed changes skipped as already reflected (`_debug`).
  const replaySkips = new Map<string, number>();

  function replayReflected(entry: RegistryEntry, replay: ReplayScope): boolean {
    if (!isPersisted(entry)) return false;
    const floor = replay.floors.get(entry.key);
    return floor !== undefined && BigInt(replay.xid) < BigInt(floor);
  }

  // Whether `{}` is a tuple of the entry — its own params gate, the one every
  // entry point runs, accepts it. A flat-form entry with no gate
  // (`acceptAnyParams`) accepts it. A gate
  // throwing anything but a contract refusal is a bug in it: it escapes, and
  // `routeTableChange` reports it for this entry — which, with nothing
  // subscribed, has no other tuple the change could have reached.
  function acceptsEmptyTuple(entry: RegistryEntry): boolean {
    try {
      entry.validateParams({});
      return true;
    } catch (err) {
      if (err instanceof ResourceContractError) return false;
      throw err;
    }
  }

  function routeEntryChange(
    entry: RegistryEntry,
    change: TableChange,
    replay?: ReplayScope,
  ): void {
    const routing = entry.routing!;
    reachFollows(entry, routing, change);
    const routes = routing.byTable.get(change.table);
    if (routes === undefined || routing.driftBases.has(change.table)) {
      // A table only the drift guard indexed (A8 fail-open): no route names it
      // — or only a tagged route, read outside its tag — so nothing scopes
      // it: every target recomputes FULL.
      for (const [pk, params] of routedTargets(entry, replay)) {
        deliverRouted(entry, pk, params, { kind: "full" }, change);
      }
      return;
    }
    for (const [pk, params] of routedTargets(entry, replay)) {
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

  // A change to a followed table, for each TRACKED tuple a follow route lets
  // it through to — its gate, the static rows and the tuple's own match:
  // the follows it reached drop their held reads (`HeldFollows`), so the next
  // read of them is fresh, and the entry's follow hook (`onFollowReached`) is
  // handed the tuple, synchronously and outside any flight, whatever the
  // entry's mode. A tuple whose read-set is unusable, or a followed table the
  // drift guard failed open (served FULL), counts as reached by every follow
  // of the table: a missed re-point would leave a watch on a stale target, a
  // held read kept past its change would serve stale rows — an extra one
  // costs one re-read. The hook's own work runs in a `bg` origin; a rejection
  // is reported.
  function reachFollows(
    entry: RegistryEntry,
    routing: RoutingRecord,
    change: TableChange,
  ): void {
    const vias = routing.via.get(change.table);
    if (vias === undefined) return;
    const hook = entry.onFollowReached;
    if (hook === undefined && routing.followHeld.size === 0) return;
    const viaRoutes = (routing.byTable.get(change.table) ?? []).filter(
      (r) => r.via !== undefined,
    );
    const drifted = routing.driftBases.has(change.table);
    const every = vias.map((v) => v.name);
    for (const [pk, params] of entry.tracked) {
      const held = routing.followHeld.get(pk);
      if (hook === undefined && held === undefined) continue;
      let reached: readonly string[] = every;
      if (!drifted) {
        try {
          const uses = usesFor(entry, routing, pk, params);
          if (uses !== null) {
            reached = every.filter(
              (name) =>
                routeTuple(
                  change,
                  viaRoutes.filter((r) => r.via!.name === name),
                  uses,
                ).kind !== "untouched",
            );
          }
        } catch (err) {
          reportLoaderError(
            `follow routing failed for ${entry.key} ${pk} (table "${change.table}")`,
            err,
          );
        }
      }
      if (reached.length === 0) continue;
      if (held !== undefined) {
        for (const name of reached) {
          if (held.reads.delete(name)) {
            followHeldDrops.set(
              entry.key,
              (followHeldDrops.get(entry.key) ?? 0) + 1,
            );
          }
        }
      }
      if (hook === undefined) continue;
      const run = () => hook(params, heldFollowsFor(entry, pk));
      void (opts.wrapOrigin ? opts.wrapOrigin("bg", entry.key, run) : run())
        .then((outcome) => {
          if (outcome === "repointed") {
            followRepoints.set(
              entry.key,
              (followRepoints.get(entry.key) ?? 0) + 1,
            );
          }
        })
        .catch((err: unknown) => {
          reportLoaderError(
            `onFollowReached failed for ${entry.key} ${pk}`,
            err,
          );
        });
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
    const uses = memoUses(entry, routing, pk, params);
    if (uses === null || routing.loadedRoutes.size === 0) return uses;
    // A loaded route's match is the last load's note: before one, or while a
    // load is in flight (it may be naming rows a skipped change touched), the
    // route reaches the tuple past its match — gate and static rows only.
    if (routing.loaded.has(pk) && !routing.loading.has(pk)) return uses;
    const open = new Map(uses);
    for (const id of routing.loadedRoutes) open.set(id, { role: "membership" });
    return open;
  }

  function memoUses(
    entry: RegistryEntry,
    routing: RoutingRecord,
    pk: string,
    params: ResourceParams,
  ): ReadonlyMap<string, TupleUse> | null {
    const memo = routing.uses.get(pk);
    if (memo !== undefined || routing.uses.has(pk)) return memo ?? null;
    let uses: ReadonlyMap<string, TupleUse> | null = null;
    try {
      const answer = routing.plan.usesOf(params, routing.loaded.get(pk)?.state);
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
  // routes are in.
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

  // Every table a reach plan reads outside the change feed by declaration
  // (`ReachPlan.unfed`) — what change-feed's boot check holds to its opt-outs.
  function unfedResourceTables(): UnfedResourceTable[] {
    const out: UnfedResourceTable[] = [];
    for (const entry of registry.values()) {
      for (const table of entry.routing?.unfed ?? []) {
        out.push({ key: entry.key, table });
      }
    }
    return out;
  }

  // Every reach plan's relation reads (see the interface).
  function relationResourceReads(): RelationResourceRead[] {
    const out: RelationResourceRead[] = [];
    for (const entry of registry.values()) {
      for (const relation of entry.routing?.relations.keys() ?? []) {
        out.push({ key: entry.key, relation });
      }
    }
    return out;
  }

  // Every bound DB-backed entry no change reaches (see the interface).
  function unroutedResourceKeys(): string[] {
    const out: string[] = [];
    for (const entry of registry.values()) {
      if (entry.externalSource || entry.routing || deferred.has(entry.key)) {
        continue;
      }
      out.push(entry.key);
    }
    return out.sort();
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
      // A snapshot read before this boot's catch-up (a sub-ack served before
      // the LISTEN session was up): the replay judges the key by its ROW's
      // floor, which another backend may have advanced past a commit this
      // read never saw and no NOTIFY delivered — so its floor is never
      // advanced until a whole read rebuilds it.
      markUnapplied(entry, paramsKey);
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
    markRebuilt(entry, paramsKey);
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
    let dropped = armedFloors.size;
    for (const timer of armedFloors.values()) clearTimeout(timer);
    armedFloors.clear();
    for (const slot of [...cuttingFloors.keys()]) {
      dropped += cuttingFloors.get(slot)!.size;
      cancelCuttingFloors(slot);
    }
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
    loadResourceFresh,
    measureSubscribeCycle,
    triggerResourcePush,
    routeTableChange,
    recomputeResource,
    notifyStatsFor,
    scopedResourceTables,
    unfedResourceTables,
    relationResourceReads,
    unroutedResourceKeys,
    indexRelationReads,
    resetRelationReads,
    seedRouteDrift,
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
    handoffState,
    readGateStats: () => readLoadGate.stats(),
  };
}
