import type {
  DependsOnEntry,
  ExternalResource,
  ExternalWindowPolicy,
  KeyedResourceContract,
  KeyedServerResourceOptions,
  Resource,
  ResourceContract,
  ResourceRuntime,
  ServerResourceOptions,
} from "@plugins/framework/plugins/resource-runtime/core";
import {
  LIVE_ROW_KEY,
  LIVE_ROW_KEY_MAX_BYTES,
  type LiveCutKey,
} from "./row-key";
import type {
  LiveKeyDirection,
  LivePagedKey,
  LivePagedValue,
  LivePlainValue,
  LiveQueryValue,
  LiveSnapshotBrand,
  LiveValue,
  LiveValueOrigin,
} from "./live-value";
import type {
  LiveKeyRange,
  LivePagedParams,
  LiveQueryParams,
} from "./query-value";
import { compareKeyParts, cutParts } from "./key-order";
import {
  followsOf,
  type CompiledFollows,
  type FollowArgs,
  type Followed,
  type FollowMap,
  type FollowsFn,
  type HasFollows,
  type NoFollows,
} from "./follows";

// The option compilation behind BOTH `serveValue`s — the worktree one
// (`network/live/server`, on server-core's runtime) and the central one
// (`network/live/central`, on central-core's). It lives here, once, so the two
// barrels cannot drift: each only injects its runtime's two register
// primitives and shapes the served object its plugin definition takes.
//
// A served value declares WHERE its truth lives (`source`) and how to read it
// (`loader`), never a delivery mode: that is the `liveValue` declaration's
// `load`, which the client reads too.
// Everything else is one named option, each folded into the runtime's own
// two-arg `defineResource` / `defineExternalResource`:
//
// - `throttleMs`        → the runtime's `debounceMs` (a fixed trailing window,
//                         not re-armed — a throttle, whatever the old name said).
// - `recomputeOn`       → `dependsOn` edges, from EXTERNAL upstreams only (T15:
//                         a db upstream's writes reach this value's read-set
//                         through the change feed already, so a cascade would
//                         serve it twice). A bare served value recomputes
//                         every currently-subscribed tuple of THIS value (the
//                         runtime's `toSubscribed` edge; a param-less value
//                         always recomputes its one `{}` tuple). The mapped form
//                         `{ value, params }` is a plain per-tuple edge.
// - `whileSubscribed`   → the runtime's `onFirstSubscribe` / `onLastUnsubscribe`
//                         pair, owned here so a start without a stop cannot be
//                         written (see `pairLifecycle`). Handed the subject
//                         (and `notify`) only, never re-started.
// - `whileFollowing`    → the same pair for a start over what `over` reads
//                         off the FOLLOWED rows (`followLifecycle`): handed
//                         `{ over }`, and the runtime's `onFollowReached`
//                         re-starts it when a change moves that. Both hooks
//                         may be declared (`bothLifecycles`).
// - `revalidate`        → passed through.
// - `follows`           → `{ followed }` beside the subject in the loader,
//                         `revalidate`, a paged value's `meta` and
//                         `whileFollowing.over`, each read fresh in the hook's
//                         own call (`./follows`). The reach plan the follows
//                         compile to is the Bun host's.
//
// A typed-query value (`liveValue(key, { query })`) and a paged one
// (`{ query, paged }`) are served by the same options, over their DECODED
// question: the loader, `whileSubscribed`, a mapped `recomputeOn` and
// `notify` take the question `Q` (the paged loader adds the key range asked,
// `LiveKeyRange`), and this file decodes each wire tuple through the
// declaration's own codec — the one the params gate and the browser's read use.
//
// A paged value is TWO resources — its pages and, declared `paged.meta`, its
// per-question `:meta` sibling — compiled together (`compilePagedValue`): one
// `whileSubscribed` per QUESTION (refcounted over every page tuple and the
// meta tuple of it, so a read that splits its pages never restarts a
// watcher), one `notify(q)` reaching all of them, and every page's answer
// checked against its range and minted its `$key` here. A page is a KEYED
// external window (the runtime's `ExternalWindowPolicy`, D3): `notify(q)`
// re-reads each live page of `q` and ships its keyed diff, and a page may be
// seeded from the pages of its question the server holds — its size and
// family read off the page codec.

/** Where a value's truth lives: Postgres (change feed) or anything else (`notify`). */
export type LiveValueSource = "db" | "external";

/**
 * How an EXTERNAL value's answer changes — required on the external arm (a db
 * value's freshness is the change feed's), so a value that is never told of a
 * change cannot be written without saying why that is honest:
 *
 * - `"notified"` — something calls `served.notify(...)`, or `whileSubscribed`
 *   (or a `recomputeOn` upstream) does. The only arm with `notify`,
 *   `whileSubscribed`, `recomputeOn` and `throttleMs`.
 * - `{ immutable: { reason } }` — a tuple's answer can never change (sha-keyed,
 *   a terminal run's artifact).
 * - `{ fixed: { reason } }` — constant for the process lifetime (a
 *   contribution registry, a catalog read once, a third-party answer with no
 *   change signal).
 * - `{ snapshot: { reason } }` — re-measured only when a reader asks: the
 *   value is declared `load: "snapshot"` (tsc pairs the two), every HTTP read
 *   runs the loader (no `revalidate`), and the read's `refresh()` is the
 *   Refresh button.
 */
export type LiveValueChanges =
  | "notified"
  | { immutable: { reason: string } }
  | { fixed: { reason: string } }
  | { snapshot: { reason: string } };

/** A `changes` naming no change signal: the served value has no `notify`. */
export type LiveUnnotifiedChanges = Exclude<LiveValueChanges, "notified">;

/** True (as a type) when `C` is the snapshot arm. */
type IsSnapshot<C> = [C] extends [{ snapshot: unknown }] ? true : false;

/**
 * The declaration a `changes` takes: a snapshot value for `{ snapshot }`, any
 * other for every other arm (see `LiveSnapshotBrand`). The db arm takes the
 * non-snapshot one (`SnapshotPairing<"notified">`).
 */
export type SnapshotPairing<C> = LiveSnapshotBrand<
  IsSnapshot<C> extends true ? "snapshot" : "push"
>;

/**
 * The declaration a `source` takes: a db value never a bytes one (a Postgres
 * row is not a binary payload, and the change feed's recompute is a push) —
 * a bytes value's `bytes: true` is not assignable to `bytes?: undefined`; an
 * external value takes either.
 */
export type BytesPairing<Src extends LiveValueSource> = Src extends "db"
  ? { bytes?: undefined }
  : unknown;

/** Stops what a `whileSubscribed` start began. */
export type StopFn = () => void;

/**
 * Any served value, whichever runtime serves it — the runtime `Resource` plus
 * what `serveValue` records about it. An upstream in `recomputeOn` is one.
 */
export type ServedValueBase<T, P extends Record<string, string>> = Resource<
  T,
  P
> & {
  source: LiveValueSource;
  /** The external arm's declared freshness (see {@link LiveValueChanges}); absent on a db value. */
  changes?: LiveValueChanges;
  /** `[key]` — symmetric with `ServedCollection.keys`. */
  keys: string[];
};

/**
 * What an external `serveValue` returns for `changes: C`: the `Notified` form
 * (with `notify`) for `"notified"`, the `Silent` one (none — nothing may tell
 * an immutable, fixed or snapshot value of a change) for every other arm.
 */
export type ServedFor<C, Notified, Silent> = [C] extends ["notified"]
  ? Notified
  : Silent;

/**
 * A served value that can be a `recomputeOn` upstream: an EXTERNAL one — told
 * apart by its `notify`, which only the external arm has (T15). A db value
 * has none, so naming one in `recomputeOn` is a tsc error. `any`: an upstream
 * of any payload/params — `Resource` is invariant in both. One definition, for
 * the worktree and the central `serveValue` alike.
 */
// biome-ignore lint/suspicious/noExplicitAny: see above.
export type ExternalServed = ServedValueBase<any, any> & {
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  notify(params?: any): void;
};

/** The params type an upstream served value is subscribed with. */
type UpstreamParams<S> = S extends { load(params: infer UP): unknown }
  ? UP
  : never;

/**
 * One `recomputeOn` entry for an upstream `S`: the bare served value
 * (recompute every subscribed tuple of this value), or `{ value, params }`
 * mapping the upstream's changed tuple to the ONE tuple of this value it moves.
 */
export type RecomputeEntry<S, P> =
  S | { value: S; params: (upstreamParams: UpstreamParams<S>) => P };

/**
 * `recomputeOn` typed per element: `R` is inferred from the array, so each
 * mapped entry's `params` sees ITS upstream's params and must return this
 * value's.
 */
export type RecomputeOn<R extends readonly ExternalServed[], P> = {
  [I in keyof R]: RecomputeEntry<R[I], P>;
};

/**
 * The collections a value reads a few rows of, by name — each a served
 * collection's tuple (`follow(served, tupleOf)`, see `./follows`). Its hooks
 * then take `{ followed }`: each follow's rows, read fresh in that call. Only
 * where a change signal reaches the value: a db value, or a `"notified"`
 * external one (`NoChangeHooks` intersects it away). Declared BEFORE the
 * hooks (`loader`, …) in the options literal, so their `followed` is typed
 * from it.
 */
interface FollowsOption<S, F> {
  follows?: FollowsFn<S, F>;
}

/**
 * `whileSubscribed`'s arguments beside its subject, per arm: none on a db
 * value (driven by the change feed alone), `notify` on a `"notified"` one.
 * The same with or without follows — the rows are `whileFollowing`'s.
 */
type StartArgs<Src extends LiveValueSource> = Src extends "db"
  ? []
  : [notify: () => void];

/**
 * `whileFollowing`'s `over` argument: the followed rows (`Followed<F>`) — and,
 * for a value with no follows, `never` (`FollowingStop` is what refuses the
 * hook there). A REST whose type is conditional (as the loader's
 * `FollowArgs`), never a conditional property: tsc types a hook's parameters
 * from `follows` only through the former.
 */
type OverArgs<F> =
  HasFollows<F> extends true ? [followed: Followed<F>] : [followed: never];

/**
 * `whileFollowing.start`'s argument beside its subject: `{ over }` (db) or
 * `{ over, notify }` (`"notified"`) — `over` what `whileFollowing.over` read
 * off the followed rows, never the rows themselves.
 */
type FollowingArgs<Src extends LiveValueSource, W> = Src extends "db"
  ? [ctx: { readonly over: W }]
  : [ctx: { readonly over: W; readonly notify: () => void }];

/**
 * What `whileFollowing.start` returns: its stop — and, for a value with no
 * follows, `never`. The RETURN refuses it there: a function ignoring its
 * `never` context would still be assignable through its parameters.
 */
type FollowingStop<F> =
  HasFollows<F> extends true ? StopFn | Promise<StopFn> : never;

/**
 * `whileFollowing` (a value with `follows` only): a start over what it reads
 * off the followed rows. `over` reads it — sync, a JSON value (compared as its
 * JSON) — and `start` is handed THAT, never the rows: a start cannot depend on
 * a row `over` did not read, so a write moving only rows it ignores (another
 * conversation joining the attempt, a chain row the tail already named)
 * re-starts nothing (`followLifecycle`).
 */
interface WhileFollowing<S, Src extends LiveValueSource, F, W> {
  over: (...followed: OverArgs<F>) => W;
  start: (params: S, ...ctx: FollowingArgs<Src, W>) => FollowingStop<F>;
}

/**
 * The change-signal options of a db value: driven by the change feed alone, so
 * its `whileSubscribed` takes the params only (a second parameter is a tsc
 * error; the rows are `whileFollowing`'s), and it declares no `changes`.
 */
interface DbChangeHooks<S, R extends readonly ExternalServed[]> {
  changes?: never;
  throttleMs?: number;
  recomputeOn?: RecomputeOn<R, S>;
  // `whileSubscribed` (`ServeOptionsBase`): a memo's lifetime — no `notify`,
  // a db value is driven by the change feed alone; with follows,
  // `whileFollowing` is handed `{ over }` and re-started when it moves.
}

/** The change-signal options of a `changes: "notified"` external value. */
interface NotifiedHooks<S, R extends readonly ExternalServed[]> {
  throttleMs?: number;
  recomputeOn?: RecomputeOn<R, S>;
  // `whileSubscribed` (`ServeOptionsBase`): a watcher, handed `notify`; with
  // follows, `whileFollowing` is handed `{ over, notify }` and re-started
  // when `over` moves.
}

/**
 * An immutable / fixed / snapshot value has no change signal, so nothing that
 * reacts to one may be spelled beside it (tsc; a throw for an untyped caller)
 * — nor a follow, which reaches the value through the feed.
 */
interface NoChangeHooks {
  throttleMs?: never;
  recomputeOn?: never;
  whileSubscribed?: never;
  whileFollowing?: never;
  follows?: never;
}

/**
 * `changes` and the hooks it admits, per arm: a db value declares none; an
 * external one must (`C`, inferred from the call), and only `"notified"`
 * admits `whileSubscribed` / `whileFollowing` / `recomputeOn` / `throttleMs`
 * / `follows`.
 */
type ChangesArm<
  Src extends LiveValueSource,
  S,
  R extends readonly ExternalServed[],
  C extends LiveValueChanges,
> = Src extends "db"
  ? DbChangeHooks<S, R>
  : {
      /** How this value's answer changes — see {@link LiveValueChanges}. Required. */
      changes: C;
    } & ([C] extends ["notified"] ? NotifiedHooks<S, R> : NoChangeHooks);

/**
 * The options every served value takes, over `S` — the SUBJECT its hooks are
 * handed: the params tuple of a plain value, the decoded question of a
 * typed-query or paged one — `L`, its loader, `C`, its declared `changes`
 * (external arm), `F`, its follows (`NoFollows` when it declares none), and
 * `W`, what its `whileFollowing` reads off them (inferred from `over`).
 */
type ServeOptionsBase<
  S,
  Src extends LiveValueSource,
  R extends readonly ExternalServed[],
  L,
  C extends LiveValueChanges,
  F,
  W,
> = {
  /** Where the value's truth lives (see the header). Required. */
  source: Src;
  /** Read the value for one tuple. Parsed against the declaration's schema. */
  loader: L;
  /**
   * Never here: a list's bound is its declaration's (`liveValue`'s schema,
   * `packages/list-bound`'s markers), whatever the source. A throw for an
   * untyped caller.
   */
  unbounded?: never;
  /**
   * Start something for as long as a tuple has a subscriber (a watcher, a
   * memo's lifetime); return what stops it. A db value's is handed the
   * subject only; a `"notified"` one's `notify`, which recomputes THIS
   * tuple; an immutable / fixed / snapshot one has none (`NoChangeHooks`).
   * Runs on the tuple's first subscriber; its stop runs on the last
   * unsubscribe — after the start resolves, if the unsubscribe comes first.
   * Never re-started, follows or not: a start that needs the followed rows is
   * `whileFollowing`.
   */
  whileSubscribed?: (
    params: S,
    ...ctx: StartArgs<Src>
  ) => StopFn | Promise<StopFn>;
  /**
   * `whileSubscribed` over the FOLLOWED rows (a value with `follows` only —
   * `never` without): `over(followed)` reads what the start needs off the
   * rows read on the subscribe path, and `start` is handed it — `{ over }` /
   * `{ over, notify }` — and re-started over the new one when a change moves
   * it (`followLifecycle` — a watch over a worktree path follows the path;
   * a write moving rows `over` ignores restarts nothing). A re-started watch
   * must notify once it is open, as a first start does. Declare what needs
   * no rows (a memo's eviction by the subject) in `whileSubscribed`, which a
   * moved row never restarts; both may be declared.
   */
  whileFollowing?: WhileFollowing<S, Src, F, W>;
} & FollowsOption<S, F> &
  ChangesArm<Src, S, R, C>;

export type ServeValueOptions<
  T,
  P,
  Src extends LiveValueSource,
  R extends readonly ExternalServed[] = [],
  C extends LiveValueChanges = "notified",
  F extends FollowMap = NoFollows,
  W = unknown,
> = ServeOptionsBase<
  P,
  Src,
  R,
  (params: P, ...ctx: FollowArgs<F>) => Promise<T> | T,
  C,
  F,
  W
> & {
  /**
   * Conditional-revalidation signature (an ETag): a cheap over-approximation
   * of "did the value change?" the read path compares before running the
   * loader. Read path only. Never on a snapshot: its every read re-measures.
   * With follows, handed `{ followed }` from the same source as the
   * loader's — each hook reads its own, fresh in its call (never one shared
   * read), and the runtime's ETag ordering rules hold for it unchanged.
   */
  revalidate?: IsSnapshot<C> extends true
    ? never
    : (params: P, ...ctx: FollowArgs<F>) => Promise<string>;
};

/**
 * A paged value's options: external only (a paged Postgres list is a
 * `liveCollection`), its loader asked one key range of a question and
 * answering its items — in the declared key order, inside the range, at most
 * its limit, ids unique (each checked: a violation fails the page loudly).
 * Every hook takes the question `Q`: `whileSubscribed` runs once per question
 * however many of its pages (and its meta) are subscribed, and `notify(query)`
 * reaches every subscribed page of it and its meta. Declared `paged.meta`,
 * `meta(query)` answers the per-question sibling (required — and refused
 * without the declaration).
 */
export type ServePagedValueOptions<
  Item,
  Meta,
  Q,
  R extends readonly ExternalServed[] = [],
  C extends PagedChanges = "notified",
  F extends FollowMap = NoFollows,
  W = unknown,
> = ServeOptionsBase<
  Q,
  "external",
  R,
  (
    query: Q,
    range: LiveKeyRange,
    ...ctx: FollowArgs<F>
  ) => Promise<readonly Item[]> | readonly Item[],
  C,
  F,
  W
> & { revalidate?: never } & MetaOption<Meta, Q, F>;

/** `meta` exactly when the declaration has `paged.meta`. */
type MetaOption<Meta, Q, F> = [Meta] extends [undefined]
  ? { meta?: never }
  : {
      /** The question's per-question fact (a total), served as `value.meta`. */
      meta: (query: Q, ...ctx: FollowArgs<F>) => Promise<Meta> | Meta;
    };

/** A paged value's `changes`: never a snapshot (a paged value is never `load: "snapshot"`). */
export type PagedChanges = Exclude<LiveValueChanges, { snapshot: unknown }>;

/**
 * A value's two-arg runtime options. This compilation never sets `reach`: a
 * value's plan comes from its declared `reads` (required on a db value,
 * optional on a `"notified"` external one), which only the Bun host can
 * compile (query-resource reads drizzle tables) — its `serveValue` adds it at
 * registration. An external value's own `notify` reaches it besides.
 */
type ValueOptions<T, P extends Record<string, string>> = ServerResourceOptions<
  T,
  P
> & { reach?: never };

/** The runtime's two-arg options for a value, plus which factory registers it. */
export interface CompiledValue<T, P extends Record<string, string>, S = P> {
  options: ValueOptions<T, P>;
  external: boolean;
  /** The external arm's declared `changes`; absent on a db value. */
  changes?: LiveValueChanges;
  /**
   * The wire tuples a change to `subject` recomputes: the params themselves
   * for a plain value, the one `{ q }` of a typed-query value, every
   * currently-subscribed page of a paged one. What `notify(subject)` and a
   * mapped `recomputeOn` reach.
   */
  tuplesOf(subject: S): P[];
  /**
   * Hand the compiled `whileSubscribed` the registered resource's `notify` (the
   * external arm's second argument). Called once, right after registration; a
   * start that runs before it throws.
   */
  bindNotify(notify: (params: P) => void): void;
}

/**
 * A paged value's pages' runtime options: a keyed external window — no
 * routes (D31), its size and family from the page codec.
 */
export type PagedPageOptions<Item> = KeyedServerResourceOptions<
  Item[],
  LivePagedParams
> &
  ExternalWindowPolicy<LivePagedParams>;

/**
 * The host-facing subset of a `ResourceRuntime` the live API registers on —
 * server-core's runtime, central-core's, or any other host's (a browser
 * server): the two register primitives, each host passing its instance (or
 * its bound functions). Everything `serveValueOn` / `serveCollectionOn`
 * compiles lands through these two.
 */
export type LiveRuntime = Pick<
  ResourceRuntime,
  "defineResource" | "defineExternalResource"
>;

/** A canonical per-tuple key (sorted entries), for the lifecycle pairing. */
export function tupleKey(params: Record<string, string>): string {
  return JSON.stringify(
    Object.keys(params)
      .sort()
      .map((k) => [k, params[k]]),
  );
}

/** A tuple's start, as the stop side sees it: its stop, or a start that failed. */
type Started = { ok: true; stop: StopFn } | { ok: false };

/**
 * Pair `whileSubscribed` onto the runtime's 0→1 / N→0 hooks. One record per
 * tuple, set synchronously by the start (so an unsubscribe can never find it
 * missing while the start is still resolving) and taken by the stop:
 *
 * - a sync start is stopped directly;
 * - an async start is RETURNED to the runtime (which awaits it before the
 *   first read, and reports a rejection), and a stop arriving first chains
 *   after it — so a watcher is never left running for a tuple nobody holds;
 * - a start that failed has nothing to stop (its error was reported on the
 *   subscribe path).
 *
 * A re-subscribe during a pending stop gets its own record: the old start's
 * stop still runs, independently.
 */
export function pairLifecycle<P extends Record<string, string>>(
  whileSubscribed: (params: P) => StopFn | Promise<StopFn>,
): {
  onFirstSubscribe: (params: P) => void | Promise<void>;
  onLastUnsubscribe: (params: P) => void;
} {
  const running = new Map<string, StopFn | Promise<Started>>();
  return {
    onFirstSubscribe(params) {
      const started = whileSubscribed(params);
      if (!(started instanceof Promise)) {
        running.set(tupleKey(params), started);
        return;
      }
      running.set(
        tupleKey(params),
        started.then(
          (stop): Started => ({ ok: true, stop }),
          // The runtime reports this rejection (the promise below is its own).
          (): Started => ({ ok: false }),
        ),
      );
      return started.then(() => undefined);
    },
    onLastUnsubscribe(params) {
      const key = tupleKey(params);
      const record = running.get(key);
      running.delete(key);
      if (record === undefined) return;
      if (!(record instanceof Promise)) {
        record();
        return;
      }
      void record.then((started) => {
        if (started.ok) started.stop();
      });
    },
  };
}

/** A tuple lifecycle the runtime's subscribe hooks run (see `pairLifecycle`, `followLifecycle`). */
export interface TupleLifecycle<P extends Record<string, string>> {
  onFirstSubscribe: (params: P) => void | Promise<void>;
  onLastUnsubscribe: (params: P) => void;
  /** Only a follower's: re-point the tuple's start (the runtime's `onFollowReached`). */
  onFollowReached?: (params: P) => Promise<FollowReached>;
}

/** What a follow re-point did (resource-runtime's `FollowReached`). */
type FollowReached = "repointed" | "unchanged";

/**
 * `pairLifecycle` for a value's `whileFollowing` (a start over what `over`
 * reads off its `follows`' rows): `read` answers that for a tuple, fresh, and
 * the start is handed it and follows it. One record per tracked tuple — its
 * tracking span (set by the 0→1 start, dropped by the N→0 stop), the
 * signature (JSON) of what its start was handed, and the start itself:
 *
 * - the 0→1 start reads, then starts — the read is awaited on the subscribe
 *   path (it is the start's input), the start's own sync-ness is kept: a
 *   sync start adds no wait, an async one is awaited as ever;
 * - `onFollowReached` (a change reached the tuple through a follow route —
 *   the runtime calls it outside any flight, in a `bg` origin) re-reads; only
 *   if the signature moved AND the tuple is still in the span that read it
 *   does it stop the old start (once it resolved) and start again over the
 *   new one — `"repointed"`. Re-points of one tuple run one at a time, in
 *   order, and a reach arriving while one is queued and not yet reading joins
 *   it (its read comes after this change too) — answered `"unchanged"`, the
 *   queued one's own caller answering for it — so the K pages and the meta of
 *   one question a change reaches re-read once;
 * - the N→0 stop stops whatever start is current, and no re-point starts
 *   after it (the replacement is set synchronously after the span check, so
 *   a stop either precedes it — nothing starts — or stops it);
 * - an untracked read (HTTP, preload, a fresh load) never reaches here: only
 *   the subscribe hooks start anything.
 *
 * A start (or re-start) that failed has nothing to stop, and started over
 * nothing: its signature is forgotten, so the next reach starts again even
 * when nothing moved — a failed watch never sits dead while subscribed.
 */
export function followLifecycle<P extends Record<string, string>, W>(
  start: (params: P, over: W) => StopFn | Promise<StopFn>,
  read: (params: P) => Promise<W>,
): Required<TupleLifecycle<P>> {
  interface Tracked {
    stopped: boolean;
    /** What the current start was handed, as JSON — `null` before any read, or once it failed. */
    signature: string | null;
    /** The number of the latest start — a failed one forgets its signature only while it is the latest. */
    attempt: number;
    current: Promise<Started>;
    /** The tail of this tuple's re-points (serialized). */
    queue: Promise<unknown>;
    /** The re-point queued and not yet reading, which a later reach joins. */
    queued: Promise<FollowReached> | null;
  }
  const running = new Map<string, Tracked>();
  const settle = (
    rec: Tracked,
    attempt: number,
    started: Promise<StopFn>,
  ): Promise<Started> =>
    started.then(
      (stop): Started => ({ ok: true, stop }),
      // The runtime reports the rejection (the promise it was handed).
      (): Started => {
        if (rec.attempt === attempt) rec.signature = null;
        return { ok: false };
      },
    );
  return {
    onFirstSubscribe(params) {
      const rec: Tracked = {
        stopped: false,
        signature: null,
        attempt: 1,
        current: Promise.resolve({ ok: false }),
        queue: Promise.resolve(),
        queued: null,
      };
      running.set(tupleKey(params), rec);
      const first = read(params).then((over) => {
        rec.signature = JSON.stringify(over);
        return start(params, over);
      });
      rec.current = settle(rec, 1, first);
      rec.queue = rec.current;
      return first.then(() => undefined);
    },
    onLastUnsubscribe(params) {
      const key = tupleKey(params);
      const rec = running.get(key);
      running.delete(key);
      if (rec === undefined) return;
      rec.stopped = true;
      void rec.current.then((started) => {
        if (started.ok) started.stop();
      });
    },
    onFollowReached(params) {
      const rec = running.get(tupleKey(params));
      if (rec === undefined) return Promise.resolve("unchanged");
      if (rec.queued !== null) {
        // Its caller answers (and the runtime reports) for it.
        return rec.queued.then(
          (): FollowReached => "unchanged",
          (): FollowReached => "unchanged",
        );
      }
      const repoint = rec.queue.then(async (): Promise<FollowReached> => {
        // Reading from here on: a reach arriving now may come after this
        // read, so it queues its own.
        rec.queued = null;
        if (rec.stopped) return "unchanged";
        const over = await read(params);
        const signature = JSON.stringify(over);
        if (rec.stopped || signature === rec.signature) return "unchanged";
        rec.signature = signature;
        const attempt = ++rec.attempt;
        const restarted = rec.current.then((previous) => {
          if (previous.ok) previous.stop();
          return start(params, over);
        });
        rec.current = settle(rec, attempt, restarted);
        await restarted;
        return "repointed";
      });
      rec.queued = repoint;
      rec.queue = repoint.then(
        () => undefined,
        () => undefined,
      );
      return repoint;
    },
  };
}

/**
 * The ONE lifecycle the runtime's subscribe hooks run for a value declaring
 * `whileSubscribed` (`pairLifecycle`) and/or `whileFollowing`
 * (`followLifecycle`): each started on 0→1 and stopped on N→0, a sync start
 * of one never delayed by the other, and only the follower re-pointed. A start
 * that fails (thrown or rejected) does not keep the other from starting; the
 * failure is the runtime's to report — both, when both fail.
 */
export function bothLifecycles<P extends Record<string, string>>(
  subscribed: TupleLifecycle<P> | undefined,
  following: Required<TupleLifecycle<P>> | undefined,
): TupleLifecycle<P> | undefined {
  if (subscribed === undefined || following === undefined) {
    return following ?? subscribed;
  }
  // Each start as a promise iff it is async (a sync throw becomes a rejection,
  // so the other still starts); `undefined` for a sync start.
  const startEach = (params: P): (Promise<void> | undefined)[] =>
    [subscribed, following].map((l) => {
      try {
        return l.onFirstSubscribe(params) ?? undefined;
      } catch (err) {
        return Promise.reject(err as Error);
      }
    });
  return {
    onFirstSubscribe(params) {
      const started = startEach(params).filter(
        (s): s is Promise<void> => s !== undefined,
      );
      if (started.length === 0) return;
      return Promise.allSettled(started).then((settled) => {
        const failed = settled.flatMap((r) =>
          r.status === "rejected" ? [r.reason as unknown] : [],
        );
        if (failed.length === 1) throw failed[0];
        if (failed.length > 1) {
          throw new AggregateError(
            failed,
            "whileSubscribed and whileFollowing both failed",
          );
        }
      });
    },
    onLastUnsubscribe(params) {
      // A throwing stop of one never leaks the other's start.
      try {
        subscribed.onLastUnsubscribe(params);
      } finally {
        following.onLastUnsubscribe(params);
      }
    },
    onFollowReached: following.onFollowReached,
  };
}

/**
 * A value's `whileFollowing`: its start, and the read of what it starts over
 * (`over` of the follows' fresh rows) — `undefined` when none is declared.
 * Refused (tsc: its context is `never` without follows) for a value that
 * follows nothing: there are no rows to start over.
 */
function followingHook(
  key: string,
  opts: AnyServeOptions,
  follows: CompiledFollows | null,
):
  | {
      start: (subject: unknown, ctx: unknown) => StopFn | Promise<StopFn>;
      read: (subject: unknown) => Promise<unknown>;
    }
  | undefined {
  if (opts.whileFollowing === undefined) return undefined;
  const hook = opts.whileFollowing as {
    over?: unknown;
    start?: unknown;
  } | null;
  if (
    typeof hook !== "object" ||
    hook === null ||
    typeof hook.over !== "function" ||
    typeof hook.start !== "function"
  ) {
    throw new Error(
      `serveValue("${key}"): \`whileFollowing\` must be ` +
        `\`{ over: (followed) => what, start: (subject, { over }) => stop }\`.`,
    );
  }
  if (follows === null) {
    throw new Error(
      `serveValue("${key}"): \`whileFollowing\` starts over the followed ` +
        `rows, and the value declares no \`follows\` — declare ` +
        `\`whileSubscribed\` instead.`,
    );
  }
  const over = hook.over as (followed: unknown) => unknown;
  return {
    start: hook.start as (
      subject: unknown,
      ctx: unknown,
    ) => StopFn | Promise<StopFn>,
    read: async (subject) => over(await follows.read(subject)),
  };
}

/**
 * How a value's wire tuples map to the subject its hooks are handed, per
 * declaration form: a plain value's subject IS its params; a typed-query
 * value's is the decoded question (one tuple per question). (A paged value's
 * are tracked by `compilePagedValue`: one question has many page tuples.)
 */
interface Subjects<P extends Record<string, string>, S> {
  of(params: P): S;
  tuplesOf(subject: S): P[];
}

function subjectsOf<P extends Record<string, string>, S>(
  value: LiveValue<unknown, P, LiveValueOrigin>,
): Subjects<P, S> {
  const decl = value as unknown as
    | { query?: undefined }
    | LiveQueryValue<unknown, unknown, unknown, LiveValueOrigin>;
  if (decl.query === undefined) {
    return {
      of: (params) => params as unknown as S,
      tuplesOf: (s) => [s as unknown as P],
    };
  }
  const codec = decl.query;
  return {
    of: (params) => codec.decode(params) as S,
    tuplesOf: (s) => [codec.encode(s) as unknown as P],
  };
}

/**
 * The runtime loader for a plain or typed-query value: a plain loader is
 * handed the params, a typed-query one the decoded question.
 */
function loaderOf<T, P extends Record<string, string>, S>(
  subjects: Subjects<P, S>,
  loader: (...args: never[]) => unknown,
  follows: CompiledFollows | null,
): (params: P) => Promise<T> | T {
  return withFollowed(
    subjects,
    loader as (...args: unknown[]) => unknown,
    follows,
  ) as (params: P) => Promise<T> | T;
}

/**
 * A hook over the wire params: handed the subject — and, for a follower,
 * `{ followed }`, read fresh in this very call (so what it computes and what
 * the follow routes reach come from one read; each hook reads its own).
 */
function withFollowed<P extends Record<string, string>, S>(
  subjects: Subjects<P, S>,
  hook: (...args: unknown[]) => unknown,
  follows: CompiledFollows | null,
): (params: P) => unknown {
  if (follows === null) return (params) => hook(subjects.of(params));
  return async (params) => {
    const subject = subjects.of(params);
    return hook(subject, { followed: await follows.read(subject) });
  };
}

/** An item of a page as the wire carries it: its fields and its `$key`. */
export type PagedRow = Record<string, unknown> & {
  [LIVE_ROW_KEY]: string | null;
};

const encoder = new TextEncoder();

/**
 * One page's answer, checked against the range it was asked and minted its
 * row keys: every item's key is `paged.key.order.length` parts, each text or
 * NULL (`key.of`), then its id (a string); the items are in strictly
 * ascending key order (so no id twice), all inside `(after, until]`, at most
 * `limit`. A violation is the loader's bug — a plain Error, failing the page
 * loudly rather than a reader that pages wrong. Each item is handed out with
 * `$key` — the canonical JSON of its key, `null` past
 * `LIVE_ROW_KEY_MAX_BYTES` (no page can be cut there).
 */
export function pageRowsOf(
  value: { key: string; paged: { id: string; key: LivePagedKey<unknown> } },
  range: LiveKeyRange,
  items: readonly unknown[],
): PagedRow[] {
  const { id, key } = value.paged;
  const fail = (detail: string): never => {
    throw new Error(`serveValue("${value.key}"): ${detail}`);
  };
  if (!Array.isArray(items)) {
    fail(`the loader returned ${typeof items}, not an array of items.`);
  }
  if (items.length > range.limit) {
    fail(
      `the loader returned ${items.length} items for a page of at most ${range.limit}.`,
    );
  }
  return mintRowKeys(
    items as readonly Record<string, unknown>[],
    (fields, i) => {
      const itemId = fields[id];
      if (typeof itemId !== "string") {
        fail(
          `item ${i}'s id (${id}) is ${JSON.stringify(itemId)}, not a string.`,
        );
      }
      const parts = key.of(fields);
      if (
        !Array.isArray(parts) ||
        parts.length !== key.order.length ||
        !parts.every((p) => p === null || typeof p === "string")
      ) {
        fail(
          `paged.key.of(item "${itemId as string}") is ${JSON.stringify(parts)} — ` +
            `it must be ${key.order.length} text (or null) part(s), one per order entry.`,
        );
      }
      return [...parts, itemId as string];
    },
    // The id is the last part, ascending.
    [...key.order, "asc"],
    {
      after: range.after === null ? null : cutParts(range.after),
      until: range.until === null ? null : cutParts(range.until),
    },
    fail,
  );
}

/**
 * Rows in key order, checked and minted their `$key` — the one check behind a
 * paged value's page ({@link pageRowsOf}) and an external collection's
 * window (`serve-on.ts`). `keyOf` reads (and checks) a row's full key — its
 * order parts, the id among them — and `dirs` is one direction per part. The
 * rows must be in strictly ascending key order (so no key twice) and inside
 * `(after, until]`; a violation goes to `fail`, which throws. Each row is
 * handed out with `$key`: the canonical JSON of its key, `null` past
 * `LIVE_ROW_KEY_MAX_BYTES` (no page can be cut there).
 */
export function mintRowKeys(
  rows: readonly Record<string, unknown>[],
  keyOf: (row: Record<string, unknown>, index: number) => LiveCutKey,
  dirs: readonly LiveKeyDirection[],
  range: { after: LiveCutKey | null; until: LiveCutKey | null },
  fail: (detail: string) => never,
): PagedRow[] {
  let previous: LiveCutKey | null = null;
  return rows.map((row, i) => {
    const full = keyOf(row, i);
    if (previous !== null && compareKeyParts(previous, full, dirs) >= 0) {
      fail(
        `the loader's items are not in strictly ascending key order: ` +
          `${JSON.stringify(previous)} then ${JSON.stringify(full)} ` +
          `(a key out of order, or an id twice).`,
      );
    }
    if (
      (range.after !== null && compareKeyParts(full, range.after, dirs) <= 0) ||
      (range.until !== null && compareKeyParts(full, range.until, dirs) > 0)
    ) {
      fail(
        `item ${JSON.stringify(full)} is outside the range asked ` +
          `(after ${JSON.stringify(range.after)}, until ${JSON.stringify(range.until)}).`,
      );
    }
    previous = full;
    const minted = JSON.stringify(full);
    return {
      ...row,
      [LIVE_ROW_KEY]:
        encoder.encode(minted).length > LIVE_ROW_KEY_MAX_BYTES ? null : minted,
    };
  });
}

/**
 * A bytes value's declared `maxBytes`, enforced on its loader: a payload past
 * it is refused `"too-large"` (the declaration's own `refuse`, which declaring
 * `maxBytes` added the code to) rather than shipped. Every other loader is
 * returned as is; a non-`ArrayBuffer` answer is left to the schema, which
 * refuses it loudly.
 */
function boundedBytes<T, P extends Record<string, string>>(
  value: LiveValue<T, P, LiveValueOrigin>,
  loader: (params: P) => Promise<T> | T,
): (params: P) => Promise<T> | T {
  const decl = value as {
    bytes?: true;
    maxBytes?: number;
    refuse?: (code: string, message: string) => Error;
  };
  const max = decl.maxBytes;
  if (decl.bytes !== true || max === undefined) return loader;
  const refuse = decl.refuse;
  if (refuse === undefined) {
    // Unreachable: `liveValue` adds `"too-large"` with `maxBytes`.
    throw new Error(
      `serveValue("${value.key}"): maxBytes without a declared "too-large" refusal.`,
    );
  }
  return async (params) => {
    const payload = await loader(params);
    const size = (payload as { byteLength?: unknown }).byteLength;
    if (typeof size === "number" && size > max) {
      throw refuse(
        "too-large",
        `${size} bytes is over the ${max}-byte limit of "${value.key}".`,
      );
    }
    return payload;
  };
}

/**
 * Derive the runtime options for a value without registering it — so a test
 * can register them on its own `createResourceRuntime` (the
 * `compileCollection` pattern; `registerValue` does both). A typed-query value
 * is `compileQueryValue` (its options over the decoded question), a paged one
 * `compilePagedValue` — one function per form rather than overloads, so a
 * wrong option is reported on its own property, not as "no overload matches".
 */
export function compileValue<
  T,
  P extends Record<string, string>,
  Src extends LiveValueSource,
  O extends LiveValueOrigin,
  const R extends readonly ExternalServed[] = [],
  C extends LiveValueChanges = "notified",
  F extends FollowMap = NoFollows,
  W = unknown,
>(
  value: LivePlainValue<T, P, O> & SnapshotPairing<C> & BytesPairing<Src>,
  // `NoInfer`: `T` / `P` come from the declaration alone — a loader returning
  // `{}` must not widen `T` past what the declaration says.
  opts: ServeValueOptions<NoInfer<T>, NoInfer<P>, Src, R, C, F, W>,
): CompiledValue<T, P> {
  return compileValueOf<T, P, P>(value, opts as AnyServeOptions);
}

/** {@link compileValue} for a typed-query value: every hook takes the decoded question `Q`. */
export function compileQueryValue<
  T,
  Q,
  QIn,
  Src extends LiveValueSource,
  O extends LiveValueOrigin,
  const R extends readonly ExternalServed[] = [],
  C extends LiveValueChanges = "notified",
  F extends FollowMap = NoFollows,
  W = unknown,
>(
  value: LiveQueryValue<T, Q, QIn, O> & SnapshotPairing<C> & BytesPairing<Src>,
  opts: ServeValueOptions<NoInfer<T>, NoInfer<Q>, Src, R, C, F, W>,
): CompiledValue<T, LiveQueryParams, Q> {
  return compileValueOf<T, LiveQueryParams, Q>(value, opts as AnyServeOptions);
}

/**
 * A paged value's compiled options: its pages (a keyed external window per
 * page tuple, `tuplesOf(q)` the pages of `q` subscribed now) and — declared
 * `paged.meta` — its meta sibling's.
 */
export type CompiledPagedValue<Item, Meta, Q> = Omit<
  CompiledValue<Item[], LivePagedParams, Q>,
  "options"
> & {
  options: PagedPageOptions<Item>;
  meta: CompiledValue<Meta, LiveQueryParams, Q> | null;
};

/** {@link compileValue} for a paged value: external only, its loader asked one key range. */
export function compilePagedValue<
  Item,
  Meta,
  Q,
  QIn,
  O extends LiveValueOrigin,
  const R extends readonly ExternalServed[] = [],
  C extends PagedChanges = "notified",
  K extends string = never,
  F extends FollowMap = NoFollows,
  W = unknown,
>(
  value: LivePagedValue<Item, Meta, Q, QIn, O, K>,
  opts: ServePagedValueOptions<
    NoInfer<Item>,
    NoInfer<Meta>,
    NoInfer<Q>,
    R,
    C,
    F,
    W
  >,
): CompiledPagedValue<Item, Meta, Q> {
  return compilePagedOf(
    value as unknown as LivePagedValue<
      unknown,
      unknown,
      unknown,
      unknown,
      LiveValueOrigin
    >,
    opts as AnyServeOptions,
  ) as unknown as CompiledPagedValue<Item, Meta, Q>;
}

/**
 * The paged compilation, erased: the pages' and the meta's options over one
 * per-question lifecycle (see the header).
 */
function compilePagedOf(
  value: LivePagedValue<unknown, unknown, unknown, unknown, LiveValueOrigin>,
  opts: AnyServeOptions,
): CompiledPagedValue<unknown, unknown, unknown> {
  if (opts.source !== "external") {
    // Unreachable from typed code (a paged value's options are external only).
    throw new Error(
      `serveValue("${value.key}"): a paged value is served \`source: "external"\` — ` +
        `a paged Postgres list is a liveCollection.`,
    );
  }
  const changes = checkChanges(value, opts);
  // A label the runtime's `_debug` payload shows per key (read-set pane).
  const freshness =
    changes !== undefined ? { freshness: freshnessOf(changes) } : {};
  refuseServedBound(value.key, opts);
  const stray = (["revalidate"] as const).filter((f) => opts[f] !== undefined);
  if (stray.length > 0) {
    throw new Error(
      `serveValue("${value.key}"): a paged value takes no \`${stray.join("`, `")}\`.`,
    );
  }
  const metaValue = value.meta as
    LiveQueryValue<unknown, unknown, unknown, LiveValueOrigin> | undefined;
  const metaLoader = opts.meta as
    ((query: unknown, ...ctx: unknown[]) => unknown) | undefined;
  if ((metaValue === undefined) !== (metaLoader === undefined)) {
    // Unreachable from typed code (`meta` is required exactly with `paged.meta`).
    throw new Error(
      metaValue === undefined
        ? `serveValue("${value.key}"): \`meta\` is served only for a value declared \`paged.meta\`.`
        : `serveValue("${value.key}"): the value declares \`paged.meta\` — serve it with \`meta(query)\`.`,
    );
  }
  const codec = value.query;
  const metaKey = (q: string): LiveQueryParams => ({ q });

  // What each question holds subscribed now: its page tuples, and whether
  // its meta tuple is. A question is held while either is non-empty.
  const pages = new Map<string, Map<string, LivePagedParams>>();
  const metaHeld = new Set<string>();
  const held = (q: string) =>
    (pages.get(q)?.size ?? 0) + (metaHeld.has(q) ? 1 : 0);

  let notifyPage: ((params: LivePagedParams) => void) | undefined;
  let notifyMeta: ((params: LiveQueryParams) => void) | undefined;
  /** Every subscribed page of `q`, and its meta — what `notify(q)` reaches. */
  const notifyQuestion = (q: string) => {
    if (
      notifyPage === undefined ||
      (metaValue !== undefined && notifyMeta === undefined)
    ) {
      throw new Error(
        `serveValue("${value.key}"): notify used before the value was registered.`,
      );
    }
    for (const tuple of pages.get(q)?.values() ?? []) notifyPage(tuple);
    if (metaHeld.has(q)) notifyMeta!(metaKey(q));
  };

  const follows = followsOf(value.key, opts.follows);
  const whileSubscribed = opts.whileSubscribed as
    | ((query: unknown, notify: () => void) => StopFn | Promise<StopFn>)
    | undefined;
  const whileFollowing = followingHook(value.key, opts, follows);
  const questions = bothLifecycles<LiveQueryParams>(
    whileSubscribed === undefined
      ? undefined
      : pairLifecycle<LiveQueryParams>(({ q }) =>
          whileSubscribed(codec.decodeQuery(q), () => notifyQuestion(q)),
        ),
    whileFollowing === undefined
      ? undefined
      : followLifecycle<LiveQueryParams, unknown>(
          ({ q }, over) =>
            whileFollowing.start(codec.decodeQuery(q), {
              over,
              notify: () => notifyQuestion(q),
            }),
          ({ q }) => whileFollowing.read(codec.decodeQuery(q)),
        ),
  );
  // A follow route reached a page or meta tuple: the question's start
  // re-points (once — a second tuple of it finds the rows unmoved).
  const followReached =
    questions?.onFollowReached === undefined
      ? {}
      : {
          onFollowReached: (params: { q: string }) =>
            questions.onFollowReached!(metaKey(params.q)),
        };
  // A question's async start still resolving. A tuple of it subscribed
  // meanwhile waits for it too, as the first did — the runtime reads a tuple
  // only once its 0→1 hook settles, so no page is loaded before the source
  // is watched (a change in between would reach no tuple).
  const starting = new Map<string, Promise<void>>();
  /** A tuple of `q` subscribed: the question's first starts its lifecycle. */
  const enter = (q: string, add: () => void): void | Promise<void> => {
    const first = held(q) === 0;
    add();
    if (!first) return starting.get(q);
    const started = questions?.onFirstSubscribe(metaKey(q));
    if (started instanceof Promise) {
      // Settled either way: a failed start is reported on the first tuple's
      // subscribe path (the runtime awaits `started` itself); a later tuple
      // only waits for it.
      const settled = started.then(
        () => undefined,
        () => undefined,
      );
      starting.set(q, settled);
      void settled.then(() => {
        if (starting.get(q) === settled) starting.delete(q);
      });
    }
    return started;
  };
  /** A tuple of `q` released: the question's last stops it. */
  const leave = (q: string, remove: () => void): void => {
    remove();
    if (held(q) === 0) questions?.onLastUnsubscribe(metaKey(q));
  };

  const pageLifecycle = {
    onFirstSubscribe: (params: LivePagedParams) =>
      enter(params.q, () => {
        let tuples = pages.get(params.q);
        if (tuples === undefined) pages.set(params.q, (tuples = new Map()));
        tuples.set(tupleKey(params), params);
      }),
    onLastUnsubscribe: (params: LivePagedParams) =>
      leave(params.q, () => {
        const tuples = pages.get(params.q);
        tuples?.delete(tupleKey(params));
        if (tuples?.size === 0) pages.delete(params.q);
      }),
  };
  const pageSubjects: Subjects<LivePagedParams, unknown> = {
    of: (params) => codec.decode(params).query,
    // The question's output re-encodes to its own `q`: a query value's schema
    // must parse idempotently, or no tuple of it passes the gate.
    tuplesOf: (s) => [...(pages.get(codec.encodeQuery(s))?.values() ?? [])],
  };
  const recomputeOn = (opts.recomputeOn ?? []) as readonly RecomputeEntry<
    ExternalServed,
    unknown
  >[];
  const loader = opts.loader as (
    query: unknown,
    range: LiveKeyRange,
    ...ctx: unknown[]
  ) => Promise<readonly unknown[]> | readonly unknown[];
  const pagesDependsOn = compileRecomputeOn(value, recomputeOn, pageSubjects);
  const compiledPages: Omit<
    CompiledPagedValue<unknown, unknown, unknown>,
    "meta"
  > = {
    options: {
      // No mode: a page is keyed (the declaration's `keyed`), a window of
      // the page codec's size whose family is its question — every page of
      // one `q` cuts one order, whatever its range and limit, so one page
      // may be seeded from another's items.
      membership: {
        kind: "window",
        limitOf: (params) => codec.decode(params).range.limit,
        familyOf: (params) => params.q,
      },
      loader: async (params: LivePagedParams) => {
        const { query, range } = codec.decode(params);
        const items =
          follows === null
            ? await loader(query, range)
            : await loader(query, range, {
                followed: await follows.read(query),
              });
        return pageRowsOf(value, range, items);
      },
      ...(opts.throttleMs !== undefined ? { debounceMs: opts.throttleMs } : {}),
      ...(pagesDependsOn.length > 0 ? { dependsOn: pagesDependsOn } : {}),
      ...pageLifecycle,
      ...followReached,
      ...freshness,
    },
    external: true,
    ...(changes !== undefined ? { changes } : {}),
    tuplesOf: (subject) => pageSubjects.tuplesOf(subject),
    bindNotify(fn) {
      notifyPage = fn;
    },
  };

  let compiledMeta: CompiledValue<unknown, LiveQueryParams, unknown> | null =
    null;
  if (metaValue !== undefined && metaLoader !== undefined) {
    const metaSubjects: Subjects<LiveQueryParams, unknown> = {
      of: (params) => metaValue.query.decode(params),
      // Like the pages: the meta tuple of a question, while it is subscribed.
      tuplesOf: (s) => {
        const tuple = metaValue.query.encode(s);
        return metaHeld.has(tuple.q) ? [tuple] : [];
      },
    };
    const metaDependsOn = compileRecomputeOn(
      metaValue,
      recomputeOn,
      metaSubjects,
    );
    compiledMeta = {
      options: {
        mode: metaValue.load === "on-demand" ? "invalidate" : "push",
        loader: async (params: LiveQueryParams) => {
          const query = metaValue.query.decode(params);
          return follows === null
            ? metaLoader(query)
            : metaLoader(query, { followed: await follows.read(query) });
        },
        ...(opts.throttleMs !== undefined
          ? { debounceMs: opts.throttleMs }
          : {}),
        ...(metaDependsOn.length > 0 ? { dependsOn: metaDependsOn } : {}),
        onFirstSubscribe: ({ q }: LiveQueryParams) =>
          enter(q, () => metaHeld.add(q)),
        onLastUnsubscribe: ({ q }: LiveQueryParams) =>
          leave(q, () => metaHeld.delete(q)),
        ...followReached,
        ...freshness,
      },
      external: true,
      ...(changes !== undefined ? { changes } : {}),
      tuplesOf: (subject) => metaSubjects.tuplesOf(subject),
      bindNotify(fn) {
        notifyMeta = fn;
      },
    };
  }
  return { ...compiledPages, meta: compiledMeta };
}

/**
 * The one compilation behind every form, erased: the declaration says which
 * form it is (`query`, `paged`), and the typed entry points above have
 * already checked the options against it.
 */
export function compileValueOf<T, P extends Record<string, string>, S>(
  value: LiveValue<T, P, LiveValueOrigin>,
  opts: AnyServeOptions,
): CompiledValue<T, P, S> {
  refuseServedBound(value.key, opts);
  const external = opts.source === "external";
  const changes = checkChanges(value, opts);
  if ((value as { paged?: unknown }).paged !== undefined) {
    // Unreachable from typed code: a paged value compiles through `compilePagedValue`.
    throw new Error(
      `serveValue("${value.key}"): a paged value compiles through compilePagedValue.`,
    );
  }
  const bytes = (value as { bytes?: true }).bytes === true;
  if (bytes && !external) {
    // Unreachable from typed code (`BytesPairing`).
    throw new Error(
      `serveValue("${value.key}"): a bytes value is served \`source: "external"\` — ` +
        `a Postgres row is not a binary payload.`,
    );
  }
  const subjects = subjectsOf<P, S>(value);
  const follows = followsOf(value.key, opts.follows);

  let notify: ((params: P) => void) | undefined;
  const notifyFor = (params: P) => () => {
    if (notify === undefined) {
      throw new Error(
        `serveValue("${value.key}"): notify used before the value was registered.`,
      );
    }
    notify(params);
  };
  const whileSubscribed = opts.whileSubscribed as
    ((subject: S, ...rest: unknown[]) => StopFn | Promise<StopFn>) | undefined;
  const whileFollowing = followingHook(value.key, opts, follows);
  const paired = bothLifecycles<P>(
    whileSubscribed === undefined
      ? undefined
      : pairLifecycle<P>((params) =>
          // The db arm's hook takes the subject only; the extra argument is
          // never passed to it.
          external
            ? whileSubscribed(subjects.of(params), notifyFor(params))
            : whileSubscribed(subjects.of(params)),
        ),
    whileFollowing === undefined
      ? undefined
      : followLifecycle<P, unknown>(
          (params, over) =>
            whileFollowing.start(
              subjects.of(params),
              external ? { over, notify: notifyFor(params) } : { over },
            ),
          (params) => whileFollowing.read(subjects.of(params)),
        ),
  );
  const lifecycle = paired ?? {};

  const dependsOn = compileRecomputeOn<P, S>(
    value,
    (opts.recomputeOn ?? []) as readonly RecomputeEntry<ExternalServed, S>[],
    subjects,
  );

  const loader = boundedBytes(
    value,
    loaderOf<T, P, S>(
      subjects,
      opts.loader as (...args: never[]) => unknown,
      follows,
    ),
  );
  const revalidate = opts.revalidate as
    ((...args: unknown[]) => Promise<string>) | undefined;
  return {
    options: {
      // Read off the DECLARATION (`liveValue`'s `load`), never a serve option:
      // the client reads the same field, so the two halves cannot disagree.
      // The runtime's own `"invalidate"` is the named opt-in's spelling.
      mode: value.load === "on-demand" ? "invalidate" : "push",
      // Only the params: the runtime's scoped-refill `ctx` is a keyed concept.
      loader: (params: P) => loader(params),
      ...(opts.throttleMs !== undefined ? { debounceMs: opts.throttleMs } : {}),
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      ...(revalidate === undefined
        ? {}
        : {
            // A plain value's own, as is: its subject IS the params.
            revalidate: (follows === null &&
            (value as { query?: unknown }).query === undefined
              ? revalidate
              : withFollowed(subjects, revalidate, follows)) as (
              params: P,
            ) => Promise<string>,
          }),
      ...lifecycle,
      // A label the runtime's `_debug` payload shows per key (read-set pane).
      ...(changes !== undefined ? { freshness: freshnessOf(changes) } : {}),
    },
    external,
    ...(changes !== undefined ? { changes } : {}),
    tuplesOf: (subject) => subjects.tuplesOf(subject),
    bindNotify(fn) {
      notify = fn;
    },
  };
}

/** `changes` as the runtime's debug label: its arm and, off `"notified"`, its reason. */
export function freshnessOf(changes: LiveValueChanges): {
  kind: "notified" | "immutable" | "fixed" | "snapshot";
  reason?: string;
} {
  if (changes === "notified") return { kind: "notified" };
  const kind = changesKind(changes);
  const reason = (changes as Record<string, { reason: string }>)[kind]!.reason;
  return { kind, reason };
}

/** The arm a `changes` names (`"notified"`, or the one key of its object form). */
function changesKind(
  changes: LiveValueChanges,
): "notified" | "immutable" | "fixed" | "snapshot" {
  if (changes === "notified") return "notified";
  if ("immutable" in changes) return "immutable";
  if ("fixed" in changes) return "fixed";
  return "snapshot";
}

/**
 * Everything tsc pairs about `changes`, checked again for an untyped caller —
 * and the one check tsc cannot make (a blank reason). Returns the declared
 * `changes` (absent on the db arm).
 *
 * - a db value declares none; an external one must;
 * - `{ immutable | fixed | snapshot }` names exactly one arm, with a reason;
 * - only `"notified"` takes `whileSubscribed` / `whileFollowing` /
 *   `recomputeOn` / `throttleMs` / `follows`;
 * - `{ snapshot }` ⇔ the value is declared `load: "snapshot"`, and a snapshot
 *   takes no `revalidate` — its every HTTP read runs the loader.
 */
function checkChanges(
  value: { key: string; snapshot?: true },
  opts: AnyServeOptions,
): LiveValueChanges | undefined {
  const where = `serveValue("${value.key}")`;
  const changes = opts.changes;
  if (opts.source !== "external") {
    if (changes !== undefined) {
      throw new Error(
        `${where}: \`changes\` is the external arm's — a db value is told of ` +
          `every change by the change feed.`,
      );
    }
    if (value.snapshot === true) {
      throw new Error(
        `${where}: a \`load: "snapshot"\` value is served \`source: ` +
          `"external"\` with \`changes: { snapshot: { reason } }\`.`,
      );
    }
    return undefined;
  }
  if (changes === undefined) {
    throw new Error(
      `${where}: an external value must declare \`changes\` — "notified", ` +
        `or { immutable | fixed | snapshot: { reason } }.`,
    );
  }
  if (changes !== "notified") {
    const arms = Object.keys(changes);
    const arm = arms[0];
    const reason = (
      changes as Record<string, { reason?: unknown } | undefined>
    )[arm ?? ""]?.reason;
    if (
      arms.length !== 1 ||
      (arm !== "immutable" && arm !== "fixed" && arm !== "snapshot") ||
      typeof reason !== "string"
    ) {
      throw new Error(
        `${where}: \`changes\` ${JSON.stringify(changes)} is not "notified" ` +
          `or one of { immutable | fixed | snapshot: { reason } }.`,
      );
    }
    if (reason.trim() === "") {
      throw new Error(
        `${where}: \`changes.${arm}.reason\` is empty — say why this value ` +
          `is never told of a change.`,
      );
    }
    const hooks = (
      [
        "whileSubscribed",
        "whileFollowing",
        "recomputeOn",
        "throttleMs",
        "follows",
      ] as const
    ).filter((h) => opts[h] !== undefined);
    if (hooks.length > 0) {
      throw new Error(
        `${where}: \`${hooks.join("`, `")}\` reacts to a change signal, and a ` +
          `\`changes: { ${arm} }\` value has none — declare \`changes: "notified"\`.`,
      );
    }
  }
  const snapshot = changes !== "notified" && "snapshot" in changes;
  if (snapshot !== (value.snapshot === true)) {
    throw new Error(
      snapshot
        ? `${where}: \`changes: { snapshot }\` needs the value declared ` +
            `\`load: "snapshot"\` — the client reads it over HTTP, on demand.`
        : `${where}: a \`load: "snapshot"\` value declares ` +
            `\`changes: { snapshot: { reason } }\`.`,
    );
  }
  if (snapshot && opts.revalidate !== undefined) {
    throw new Error(
      `${where}: a snapshot takes no \`revalidate\` — every read re-measures.`,
    );
  }
  return changes;
}

/** The options of any form, erased — the implementation signatures' view. */
export interface AnyServeOptions {
  source: LiveValueSource;
  changes?: LiveValueChanges;
  loader: unknown;
  meta?: unknown;
  throttleMs?: number;
  recomputeOn?: readonly unknown[];
  revalidate?: unknown;
  whileSubscribed?: unknown;
  /** A start over the followed rows — only beside `follows` (`followingHook`). */
  whileFollowing?: unknown;
  /** The collections the value follows (`./follows`). */
  follows?: unknown;
  /** Refused (see {@link refuseServedBound}). */
  unbounded?: unknown;
}

/**
 * A serve call names no list bound: the shape is the declaration's — its
 * schema's `packages/list-bound` markers, walked by `liveValue` — and the
 * serve call decides only the freshness. The retired serve-side
 * `unbounded: { reason }` (a tsc error) throws for an untyped caller, so a
 * reason cannot sit where nothing reads it.
 */
function refuseServedBound(key: string, opts: AnyServeOptions): void {
  if (opts.unbounded !== undefined) {
    throw new Error(
      `serveValue("${key}"): \`unbounded\` is not a serve option — a list's ` +
        `bound is declared in the liveValue's schema (wholeList / wholeRecord ` +
        `with the reason, or a cap: packages/list-bound).`,
    );
  }
}

/**
 * `recomputeOn` → `dependsOn`. A bare upstream recomputes every subscribed
 * tuple — except on a param-less value, whose one tuple `{}` is recomputed
 * whether or not a tab holds it right now: an L2-persisted value, or one a
 * downstream maps, must follow its upstream with no subscriber. (A tab's old
 * copy needs no recompute to be refused: the runtime opens every subscription
 * span with a fresh version.) A mapped entry names a SUBJECT (a question, for a
 * query value), recomputing the tuples it reaches.
 */
function compileRecomputeOn<P extends Record<string, string>, S>(
  value: { key: string; params: readonly string[] },
  entries: readonly RecomputeEntry<ExternalServed, S>[],
  subjects: Subjects<P, S>,
): DependsOnEntry<P>[] {
  return entries.map((entry): DependsOnEntry<P> => {
    if ("value" in entry) {
      const toSubject = entry.params;
      return {
        resource: entry.value,
        map: (upstreamParams: unknown) =>
          subjects.tuplesOf(
            toSubject(upstreamParams as UpstreamParams<ExternalServed>),
          ),
      };
    }
    const upstream = entry as ExternalServed;
    if (value.params.length === 0) {
      return { resource: upstream, map: () => [{} as P] };
    }
    return { resource: upstream, toSubscribed: true };
  });
}

/**
 * Compile and register a value on `runtime`, and bind its `notify` into the
 * lifecycle. Returns the runtime resource (external ⇒ with `notify`).
 */
export function registerValue<
  T,
  P extends Record<string, string>,
  O extends LiveValueOrigin,
  Src extends LiveValueSource,
  const R extends readonly ExternalServed[] = [],
  C extends LiveValueChanges = "notified",
  F extends FollowMap = NoFollows,
  W = unknown,
>(
  runtime: LiveRuntime,
  value: LivePlainValue<T, P, O> & SnapshotPairing<C> & BytesPairing<Src>,
  opts: ServeValueOptions<NoInfer<T>, NoInfer<P>, Src, R, C, F, W>,
): Registered<T, P> {
  return registerValueOf<T, P, P>(runtime, value, opts as AnyServeOptions);
}

/** {@link registerValue} for a typed-query value (see {@link compileQueryValue}). */
export function registerQueryValue<
  T,
  Q,
  QIn,
  O extends LiveValueOrigin,
  Src extends LiveValueSource,
  const R extends readonly ExternalServed[] = [],
  C extends LiveValueChanges = "notified",
  F extends FollowMap = NoFollows,
  W = unknown,
>(
  runtime: LiveRuntime,
  value: LiveQueryValue<T, Q, QIn, O> & SnapshotPairing<C> & BytesPairing<Src>,
  opts: ServeValueOptions<NoInfer<T>, NoInfer<Q>, Src, R, C, F, W>,
): Registered<T, LiveQueryParams, Q> {
  return registerValueOf<T, LiveQueryParams, Q>(
    runtime,
    value,
    opts as AnyServeOptions,
  );
}

/** {@link registerValue} for a paged value: its pages and its meta sibling, each with its notify bound. */
export function registerPagedValue<
  Item,
  Meta,
  Q,
  QIn,
  O extends LiveValueOrigin,
  const R extends readonly ExternalServed[] = [],
  C extends PagedChanges = "notified",
  K extends string = never,
  F extends FollowMap = NoFollows,
  W = unknown,
>(
  runtime: LiveRuntime,
  value: LivePagedValue<Item, Meta, Q, QIn, O, K>,
  opts: ServePagedValueOptions<
    NoInfer<Item>,
    NoInfer<Meta>,
    NoInfer<Q>,
    R,
    C,
    F,
    W
  >,
): RegisteredPaged<Item, Meta, Q> {
  return registerPagedOf(
    runtime,
    value as unknown as LivePagedValue<
      unknown,
      unknown,
      unknown,
      unknown,
      LiveValueOrigin
    >,
    opts as AnyServeOptions,
  ) as unknown as RegisteredPaged<Item, Meta, Q>;
}

/** The paged registration, erased (see {@link compilePagedOf}). */
export function registerPagedOf(
  runtime: LiveRuntime,
  value: LivePagedValue<unknown, unknown, unknown, unknown, LiveValueOrigin>,
  opts: AnyServeOptions,
): RegisteredPaged<unknown, unknown, unknown> {
  const compiled = compilePagedOf(value, opts);
  // A paged value's descriptor is a keyed contract (`keyed.keyOf`, its id).
  const pages = runtime.defineExternalResource(
    value as unknown as KeyedResourceContract<unknown[], LivePagedParams>,
    compiled.options,
  );
  compiled.bindNotify((params) => pages.notify(params));
  const metaValue = value.meta as
    LiveQueryValue<unknown, unknown, unknown, LiveValueOrigin> | undefined;
  let meta: RegisteredPaged<unknown, unknown, unknown>["meta"] = null;
  if (metaValue !== undefined && compiled.meta !== null) {
    const resource = runtime.defineExternalResource(
      metaValue as unknown as ResourceContract<unknown, LiveQueryParams> & {
        keyed?: never;
      },
      compiled.meta.options,
    );
    compiled.meta.bindNotify((params) => resource.notify(params));
    meta = { resource, compiled: compiled.meta };
  }
  return { resource: pages, compiled, meta };
}

/** What `registerPagedValue` returns: the pages' resource, the meta's, and their compiled options. */
export interface RegisteredPaged<Item, Meta, Q> {
  resource: ExternalResource<Item[], LivePagedParams>;
  compiled: CompiledPagedValue<Item, Meta, Q>;
  meta: {
    resource: ExternalResource<Meta, LiveQueryParams>;
    compiled: CompiledValue<Meta, LiveQueryParams, Q>;
  } | null;
}

/** The registration behind every form, erased (see {@link compileValueOf}). */
export function registerValueOf<T, P extends Record<string, string>, S>(
  runtime: LiveRuntime,
  value: LiveValue<T, P, LiveValueOrigin>,
  opts: AnyServeOptions,
): Registered<T, P, S> {
  const compiled = compileValueOf<T, P, S>(value, opts);
  // A `LiveValue` is structurally a non-keyed `ResourceContract` (`keyed?: never`).
  const contract = value as ResourceContract<T, P> & { keyed?: never };
  if (compiled.external) {
    const resource = runtime.defineExternalResource(contract, compiled.options);
    compiled.bindNotify((params) => resource.notify(params));
    return { resource, compiled };
  }
  const resource = runtime.defineResource(contract, compiled.options);
  return { resource, compiled };
}

/** What `registerValue` returns: the runtime resource and its compiled options. */
export interface Registered<T, P extends Record<string, string>, S = P> {
  resource: Resource<T, P> | ExternalResource<T, P>;
  compiled: CompiledValue<T, P, S>;
}
