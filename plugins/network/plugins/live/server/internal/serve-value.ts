import {
  defineDeferredResource,
  defineExternalResource,
  defineResource,
  Resource as ResourceContribution,
} from "@plugins/framework/plugins/server-core/core";
import type {
  ReachPlan,
  ResourceParams,
  ResourceRuntime,
  ServerResourceOptions,
} from "@plugins/framework/plugins/resource-runtime/core";
import {
  compiledValueReach,
  type FollowRead,
  type ValueReads,
} from "@plugins/infra/plugins/query-resource/server";
import {
  type LivePagedParams,
  type LivePagedPages,
  type LivePagedValue,
  type LivePreloadedParamValue,
  type LiveQueryParams,
  type LiveQueryValue,
  type LiveValue,
  type LiveValueOrigin,
  type LivePortableDecl,
} from "@plugins/network/plugins/live/core";
import type { MachineFeature } from "@plugins/infra/plugins/endpoints/core";
import { serveValueOn } from "../../core";
import { canonicalParams } from "@plugins/packages/plugins/canonical-params/core";
import type {
  AnyServeOptions,
  BytesPairing,
  ExternalServed,
  LiveRuntime,
  LiveValueChanges,
  PagedChanges,
  ServedFor,
  ServedValueBase,
  ServePagedValueOptions,
  ServeValueOptions,
  SnapshotPairing,
} from "../../core";
import {
  followReaches,
  followsDeferred,
  followsOf,
  followSubjectOf,
  type FollowMap,
  type FollowsFn,
  type NoFollows,
} from "../../core";

// `serveValue` — the server half of a worktree `liveValue`. It declares WHERE the
// value's truth lives (`source`) and how to read it (`loader`), never a delivery
// mode: a value is pushed whole whenever it changes, unless its `liveValue`
// declaration opts into `load: "on-demand"` (declared there because the client
// reads it too).
//
// - `source: "db"` — the truth is Postgres. The value declares the tables its
//   loader reads (`reads`, with a reason); a change to any of them recomputes
//   every subscribed tuple (a FULL recompute — whole tables only: the loader's
//   SQL is hand-written, so no per-row filter could be kept in step with it; a
//   keyed payload is a collection). The runtime's drift guard holds the loader
//   to the declaration. There is no `notify`.
// - `source: "external"` — the truth lives outside Postgres (git, files, an
//   in-memory registry), which no change feed can see. It must declare how its
//   answer changes (`changes`, `LiveValueChanges`): `"notified"` — the served
//   value has `notify(params?)`, and nothing else does — or an immutable,
//   fixed or snapshot answer, with its reason and no `notify`. A `"notified"`
//   value whose loader ALSO reads Postgres (a lookup beside its files, a
//   config-gated query) declares those reads (`reads`, as the db arm does): a
//   write to one recomputes every subscribed tuple, merged with its notifies,
//   and the drift guard holds the loader to them as it holds a db value's. A
//   paged value's pages take them too (a static list, never a thunk), as
//   whole relation reads of their keyed windows: a write re-reads every
//   subscribed page, and its meta sibling recomputes.
// - `follows` (db, and `"notified"` external, paged included) — the
//   collection tuples the value reads (`../../core/internal/follows`): each
//   follow's routes are copied from the collection's own plan into the
//   value's reach (query-resource's `followRead`, compiled here with
//   `reads` — optional beside a follow — by `compiledValueReach`), so a write
//   reaches only the tuples whose followed rows it can move. A follow of a
//   deferred collection (one folding exposures) binds the value at
//   `bindDeferredResources` too (never a paged value's: its pages register at
//   once).
//
// The body is the core's `serveValueOn` — the one serving code path every host
// runs (central and a browser server too) — on server-core's runtime; this
// wrapper adds only the Bun host's part: the `Resource.Declare` contribution
// and a param'd preload's boot tuples.

/** A served value: the runtime resource, its key, and its one `Resource.Declare`. */
export type ServedValue<T, P extends Record<string, string>> = ServedValueBase<
  T,
  P
> & {
  /** Spread into the plugin's `contributions`: `[...served.declare]`. */
  declare: [ReturnType<typeof ResourceContribution.Declare>];
};

/** A served external value: a {@link ServedValue} plus `notify`. */
export type ServedExternalValue<
  T,
  P extends Record<string, string>,
> = ServedValue<T, P> & {
  /** The truth changed: recompute (and push) this tuple — `{}` when omitted. */
  notify(params?: P): void;
};

/**
 * A served typed-query value from an external source: `notify(query)`
 * recomputes that question's one tuple (encoded through the declaration's
 * codec, so it is the tuple a read of the question holds).
 */
export type ServedExternalQueryValue<T, Q> = ServedValue<T, LiveQueryParams> & {
  notify(query: Q): void;
};

/**
 * A served paged value (always external): its pages' resource, and
 * `notify(query)` recomputing every page of that question a tab holds right
 * now and its meta. `keys` and `declare` name both resources (`[key,
 * key:meta]` when declared `paged.meta`) — spread `declare` like a
 * collection's.
 */
export type ServedPagedValue<Item, Q> = ServedSilentPagedValue<Item> & {
  notify(query: Q): void;
};

/**
 * A served paged value declared `changes: { immutable | fixed }`: nothing may
 * tell it of a change, so it has no `notify`.
 */
export type ServedSilentPagedValue<Item> = ServedValueBase<
  Item[],
  LivePagedParams
> & {
  source: "external";
  declare: ReturnType<typeof ResourceContribution.Declare>[];
};

/**
 * What a db value's loader reads, declared (see query-resource's `ValueReads`):
 * whole tables and why, and the compiled lookups it reads through (each keyed
 * off the tuple's wire params `P`), compiled to the value's routing plan. A thunk when the
 * tables come from a registry that is complete only once contributions are
 * collected (the value is then bound at `bindDeferredResources`, before the
 * change feed builds its triggers) — such a value must be pushed (`load` not
 * `"on-demand"`).
 */
export type ServedValueReads<P extends ResourceParams = ResourceParams> =
  ValueReads<P> | (() => ValueReads<P>);

/**
 * A value's `reads` under whatever params its lookups key off — what the
 * untyped serving code holds (each overload types it by the value's params;
 * `never` because a lookup's `usesOf` takes them, so any `P` narrows to it).
 */
type AnyServedValueReads = ServedValueReads<never>;

/**
 * A db value's reads: no `notified` relations — a db value has no notify, so
 * nothing could carry their changes (the runtime refuses one too).
 */
type DbValueReads<P extends ResourceParams> = ValueReads<P> & {
  notified?: never;
};

/** The db arm's declaration of what its loader reads. Required (without `follows`). */
interface DbReadsOption<P extends ResourceParams> {
  /** Every table the loader reads, and why a write to any row may change any tuple. */
  reads: DbValueReads<P> | (() => DbValueReads<P>);
  follows?: never;
}

/**
 * A db value that `follows` collections (see `../../core/internal/follows`):
 * the follows declare what its loader reads through them, so `reads` is
 * optional — the tables it reads besides. Its own overloads, ahead of the
 * plain db ones: a `reads` whose optionality hung off the inferred follows
 * would hide them from the hooks' contextual types.
 */
interface DbFollowsOption<S, P extends ResourceParams, F> {
  follows: FollowsFn<S, F>;
  /** Every table the loader reads besides its follows, and why a write to any row may change any tuple. */
  reads?: DbValueReads<P> | (() => DbValueReads<P>);
}

/**
 * The external arm's declaration of the Postgres reads its loader makes beside
 * its own truth — optional, and only on a `changes: "notified"` value (an
 * immutable, fixed or snapshot value claims no push, so a write could tell it
 * nothing). Compiled like the db arm's, a thunk bound at
 * `bindDeferredResources`. Without it, a loader that reads Postgres anyway is
 * caught by the runtime's undeclared-read guard (D5): reported, thrown under
 * a test runner.
 */
type ExternalReadsOption<
  C extends LiveValueChanges,
  P extends ResourceParams,
> = [C] extends ["notified"]
  ? {
      /** Every table the loader reads, and why a write to any row may change any tuple. */
      reads?: ServedValueReads<P>;
    }
  : { reads?: never };

/**
 * A `"notified"` paged value's Postgres reads, beside its own truth (its
 * pages' loader and its meta's): a static list — the pages are keyed windows
 * registered at once, so there is no deferred bind for a thunk. Compiled into
 * ONE reach plan both the pages (an external keyed window, D31) and the meta
 * register with: a write to a whole table re-reads every subscribed page and
 * recomputes every meta; a write a lookup reads re-reads only the pages and
 * meta of the questions asking about its row — and none, when it touched no
 * column the lookup reads. A lookup's key comes from the question's wire `q`
 * (`LiveQueryParams`, which every page tuple carries too).
 */
type PagedReadsOption<C extends LiveValueChanges> = [C] extends ["notified"]
  ? {
      /** Every table the pages and the meta read, and why a write to any row may change any page. */
      reads?: ValueReads<LiveQueryParams>;
    }
  : { reads?: never };

/** Any other worktree value: its `serveValue` takes no `preloadParams`. */
type PlainValue<T, P extends Record<string, string>> = LiveValue<T, P> & {
  preloadsParams?: never;
  query?: undefined;
};

/**
 * The tuples a parameterized preloaded value hydrates at boot. It has no
 * default tuple, so the server names them: the boot snapshot loads each one
 * (the loader stays the only source of the value) and the client hydrates it
 * before first paint. Enumerate exactly what first paint reads — every tuple is
 * loaded on every page load.
 */
interface PreloadParamsOption<P> {
  preloadParams: () => P[] | Promise<P[]>;
}

/**
 * The `needsMachine` a host serves paged values of, as every value: `live/server`
 * a portable one (`undefined`), `live/machine` one declared `needsMachine`. A
 * conditional on the HOST, resolved where the overloads are instantiated and
 * passed as the declaration's own type argument — an intersection with `H`
 * would cost the paged overload its inference of `Item` / `Meta`.
 */
type PagedMachine<H> = [H] extends [LivePortableDecl]
  ? undefined
  : MachineFeature;

/**
 * `serveValue`'s overloads, over the declarations a host serves (`H`,
 * intersected into each overload's declaration): `LivePortableDecl` for
 * `live/server`'s — a read every host can answer — and `LiveMachineDecl` for
 * `live/machine`'s — one declared `needsMachine`. One overload set, so the two
 * barrels cannot drift, and each is a tsc error for the other's declaration.
 */
export interface ServeValueOverloads<H> {
  <
    Item,
    Meta,
    Q,
    QIn,
    const R extends readonly ExternalServed[] = [],
    C extends PagedChanges = "notified",
    K extends string = never,
    F extends FollowMap = NoFollows,
    W = unknown,
  >(
    value: LivePagedValue<Item, Meta, Q, QIn, "worktree", K, PagedMachine<H>>,
    opts: ServePagedValueOptions<
      NoInfer<Item>,
      NoInfer<Meta>,
      NoInfer<Q>,
      R,
      C,
      F,
      W
    > &
      PagedReadsOption<C>,
  ): ServedFor<C, ServedPagedValue<Item, Q>, ServedSilentPagedValue<Item>>;
  <
    T,
    Q,
    QIn,
    const R extends readonly ExternalServed[] = [],
    F extends FollowMap = NoFollows,
    W = unknown,
  >(
    value: LiveQueryValue<T, Q, QIn> &
      SnapshotPairing<"notified"> &
      BytesPairing<"db"> &
      H,
    opts: ServeValueOptions<NoInfer<T>, NoInfer<Q>, "db", R, "notified", F, W> &
      DbFollowsOption<NoInfer<Q>, LiveQueryParams, F>,
  ): ServedValue<T, LiveQueryParams>;
  <T, Q, QIn, const R extends readonly ExternalServed[] = []>(
    value: LiveQueryValue<T, Q, QIn> &
      SnapshotPairing<"notified"> &
      BytesPairing<"db"> &
      H,
    opts: ServeValueOptions<NoInfer<T>, NoInfer<Q>, "db", R> &
      DbReadsOption<LiveQueryParams>,
  ): ServedValue<T, LiveQueryParams>;
  <
    T,
    Q,
    QIn,
    const R extends readonly ExternalServed[] = [],
    C extends LiveValueChanges = "notified",
    F extends FollowMap = NoFollows,
    W = unknown,
  >(
    value: LiveQueryValue<T, Q, QIn> & SnapshotPairing<C> & H,
    opts: ServeValueOptions<NoInfer<T>, NoInfer<Q>, "external", R, C, F, W> &
      ExternalReadsOption<C, LiveQueryParams>,
  ): ServedFor<
    C,
    ServedExternalQueryValue<T, Q>,
    ServedValue<T, LiveQueryParams>
  >;
  <
    T,
    P extends Record<string, string>,
    const R extends readonly ExternalServed[] = [],
    F extends FollowMap = NoFollows,
    W = unknown,
  >(
    value: LivePreloadedParamValue<T, P> & H,
    opts: ServeValueOptions<NoInfer<T>, NoInfer<P>, "db", R, "notified", F, W> &
      DbFollowsOption<NoInfer<P>, NoInfer<P>, F> &
      PreloadParamsOption<NoInfer<P>>,
  ): ServedValue<T, P>;
  <
    T,
    P extends Record<string, string>,
    const R extends readonly ExternalServed[] = [],
  >(
    value: LivePreloadedParamValue<T, P> & H,
    opts: ServeValueOptions<NoInfer<T>, NoInfer<P>, "db", R> &
      DbReadsOption<NoInfer<P>> &
      PreloadParamsOption<NoInfer<P>>,
  ): ServedValue<T, P>;
  <
    T,
    P extends Record<string, string>,
    const R extends readonly ExternalServed[] = [],
    C extends LiveValueChanges = "notified",
    F extends FollowMap = NoFollows,
    W = unknown,
  >(
    value: LivePreloadedParamValue<T, P> & SnapshotPairing<C> & H,
    opts: ServeValueOptions<NoInfer<T>, NoInfer<P>, "external", R, C, F, W> &
      PreloadParamsOption<NoInfer<P>> &
      ExternalReadsOption<C, NoInfer<P>>,
  ): ServedFor<C, ServedExternalValue<T, P>, ServedValue<T, P>>;
  <
    T,
    P extends Record<string, string>,
    const R extends readonly ExternalServed[] = [],
    F extends FollowMap = NoFollows,
    W = unknown,
  >(
    value: PlainValue<T, P> &
      SnapshotPairing<"notified"> &
      BytesPairing<"db"> &
      H,
    opts: ServeValueOptions<NoInfer<T>, NoInfer<P>, "db", R, "notified", F, W> &
      DbFollowsOption<NoInfer<P>, NoInfer<P>, F> & {
        preloadParams?: never;
      },
  ): ServedValue<T, P>;
  <
    T,
    P extends Record<string, string>,
    const R extends readonly ExternalServed[] = [],
  >(
    value: PlainValue<T, P> &
      SnapshotPairing<"notified"> &
      BytesPairing<"db"> &
      H,
    opts: ServeValueOptions<NoInfer<T>, NoInfer<P>, "db", R> &
      DbReadsOption<NoInfer<P>> & {
        preloadParams?: never;
      },
  ): ServedValue<T, P>;
  <
    T,
    P extends Record<string, string>,
    const R extends readonly ExternalServed[] = [],
    C extends LiveValueChanges = "notified",
    F extends FollowMap = NoFollows,
    W = unknown,
  >(
    value: PlainValue<T, P> & SnapshotPairing<C> & H,
    opts: ServeValueOptions<NoInfer<T>, NoInfer<P>, "external", R, C, F, W> &
      ExternalReadsOption<C, NoInfer<P>> & {
        preloadParams?: never;
      },
  ): ServedFor<C, ServedExternalValue<T, P>, ServedValue<T, P>>;
}

/**
 * Serve a worktree `liveValue` (a central one is served by
 * `network/live/central`'s `serveValue` — passing it here is a tsc error).
 *
 * ```ts
 * export const unreadServed = serveValue(notificationsUnread, {
 *   source: "db",
 *   reads: { tables: [notifications], reason: "the badge counts every row" },
 *   loader: countUnread,
 * });
 * // contributions: [...unreadServed.declare]
 *
 * export const refHeadServed = serveValue(refHead, {
 *   source: "external",
 *   changes: "notified",                  // or { immutable | fixed | snapshot: { reason } }
 *   loader: ({ refName }) => readRefHead(refName),
 *   throttleMs: 300,
 * });
 * refHeadServed.notify({ refName });
 * ```
 *
 * A typed-query value's options take the DECODED question (`loader(query)`,
 * `whileSubscribed(query, notify)`, `notify(query)`); a paged value's loader is
 * asked one key range — `loader(query, { after, until, limit })` → the items
 * in it, in key order (`sliceRange` answers it for a list held in memory) —
 * its meta sibling `meta(query)`, and it is external only (a paged `"db"`
 * value is a tsc error):
 *
 * ```ts
 * export const metricQueryServed = serveValue(metricQuery, {
 *   source: "external",
 *   changes: "notified",
 *   loader: (q) => runQuery(q),
 *   whileSubscribed: (q, notify) => watch(q.metric, notify),
 * });
 * export const detailsServed = serveValue(metricDetails, {
 *   source: "external",
 *   changes: "notified",
 *   loader: (q, range) => details(q, range),
 *   meta: (q) => ({ total: count(q) }),
 * });
 * ```
 */
export const serveValue: ServeValueOverloads<LivePortableDecl> =
  serveAnyValue as ServeValueOverloads<LivePortableDecl>;

/**
 * `serveValue`'s body, for a declaration of either kind — the one serving code
 * path `live/server` and `live/machine` both expose (typed by
 * {@link ServeValueOverloads}).
 */
export function serveAnyValue<T, P extends Record<string, string>>(
  value:
    | (LiveValue<T, P> & {
        preloadsParams?: true;
        query?: unknown;
        paged?: unknown;
      })
    // biome-ignore lint/suspicious/noExplicitAny: a generic item's schema is invariant — erased, as page-source's `AnyPagedValue` is.
    | LivePagedPages<any, any, any>,
  opts: AnyServeOptions & {
    preloadParams?: () => P[] | Promise<P[]>;
    reads?: AnyServedValueReads;
  },
):
  | ServedValue<T, P>
  | ServedExternalValue<T, P>
  | ServedPagedValue<unknown, unknown>
  | ServedSilentPagedValue<unknown> {
  // A paged value's pages are the one keyed value (a keyed window each).
  if (value.keyed !== undefined) {
    return servePaged(
      value as unknown as LivePagedValue<unknown, unknown, unknown, unknown>,
      opts,
    );
  }
  // The pairing tsc enforces, for an untyped caller: a param'd preloaded value
  // names its boot tuples, and nothing else may.
  if ((value.preloadsParams === true) !== (opts.preloadParams !== undefined)) {
    throw new Error(
      value.preloadsParams === true
        ? `serveValue("${value.key}"): a parameterized value declared \`preload\` ` +
            `must pass \`preloadParams\` — the boot snapshot has no default tuple ` +
            `to load for it.`
        : `serveValue("${value.key}"): \`preloadParams\` is only for a ` +
            `parameterized value declared \`preload\`.`,
    );
  }
  // Erased: the overloads checked the options against the declaration's
  // form, and the compilation dispatches on the declaration itself.
  const served = serveValueOn<T, P, "db+external">(
    runtimeFor(value as LiveValue<T, P, LiveValueOrigin>, opts),
    value as LiveValue<T, P, LiveValueOrigin>,
    opts,
    { sources: "db+external" },
  );
  const enumerate = opts.preloadParams;
  const optional = value.optionalParams;
  // The boot snapshot's read of an enumerated preload. Each tuple is canonical
  // (the tuple a read subscribes — `canonicalParams`) and is loaded through the
  // resource's own `load` (the loader + schema parse), sequentially and settled
  // on its own. Deliberately NOT the runtime's flight path: that captures a
  // commit watermark (one DB query) per load, a floor nothing reads for a value
  // that is only hydrated.
  const preloadTuples =
    enumerate === undefined
      ? undefined
      : async () => {
          const out: (
            | { params: P; ok: true; value: unknown }
            | { params: P; ok: false; error: unknown }
          )[] = [];
          for (const raw of await enumerate()) {
            const params = canonicalParams(raw, optional);
            try {
              out.push({
                params,
                ok: true,
                value: await served.load(params),
              });
            } catch (error) {
              out.push({ params, ok: false, error });
            }
          }
          return out;
        };
  return {
    ...served,
    declare: [
      ResourceContribution.Declare({
        key: served.key,
        mode: served.mode,
        ...(served.preload !== undefined ? { preload: served.preload } : {}),
        ...(preloadTuples !== undefined ? { preloadTuples } : {}),
      }),
    ] as [ReturnType<typeof ResourceContribution.Declare>],
  } as ServedValue<T, P> | ServedExternalValue<T, P>;
}

/** The register primitives a value's runtime is built over — server-core's in production. */
export type ValueHost = Pick<
  ResourceRuntime,
  "defineResource" | "defineDeferredResource" | "defineExternalResource"
>;

const SERVER_HOST: ValueHost = {
  defineResource,
  defineDeferredResource,
  defineExternalResource,
};

/** The runtime a served value registers on: server-core's (see {@link valueRuntime}). */
function runtimeFor(
  value: FollowerDecl,
  opts: { reads?: AnyServedValueReads; follows?: unknown },
): LiveRuntime {
  return valueRuntime(value, opts, SERVER_HOST);
}

/** The declaration of a value whose follows `valueRuntime` compiles: any form. */
type FollowerDecl =
  | LiveValue<unknown, Record<string, string>, LiveValueOrigin>
  | LivePagedValue<unknown, unknown, unknown, unknown, LiveValueOrigin>;

/**
 * The runtime a value registers on: `host`'s, with a value's declared `reads`
 * and its `follows` compiled into the routing plan (`reach`) its registration
 * carries — at once, or at the host's `bindDeferredResources` for a `reads`
 * thunk or a follow of a deferred collection (an external one through the
 * runtime's deferred-external arm, so it is external, with its freshness,
 * from definition) — a paged value's keyed pages included (an external keyed
 * window takes a full-only reach plan, D31). Checked when the value
 * registers, after its other options: a db value with neither `reads` nor
 * `follows`, and `reads` on an external value that is not `"notified"`, are
 * refused (tsc pairs them; this is the untyped caller's check).
 */
export function valueRuntime(
  value: FollowerDecl,
  opts: { reads?: AnyServedValueReads; follows?: unknown },
  host: ValueHost,
): LiveRuntime {
  const { defineResource, defineDeferredResource, defineExternalResource } =
    host;
  const key = value.key;
  const label = `serveValue("${key}")`;
  const { reads } = opts;
  // The follows: compiled once (shared with the serving path's own
  // compile), their routes copied from each collection's plan when the
  // value's plan compiles — at its bind, for a deferred collection's.
  const follows = followsOf(key, opts.follows);
  const deferredFollows = follows !== null && followsDeferred(follows);
  const followReads = (): FollowRead<never>[] =>
    follows === null
      ? []
      : (followReaches(
          key,
          follows,
          followSubjectOf(value),
        ) as FollowRead<never>[]);
  const routed = (options: object, declared: ValueReads<never> | undefined) =>
    ({
      ...options,
      reach: compiledValueReach(
        declared,
        label,
        followReads(),
      ) as ReachPlan<ResourceParams>,
    }) as never;
  const declaredNow = () => (typeof reads === "function" ? reads() : reads);
  const define = (contract: never, options: object) => {
    if (reads === undefined && follows === null) {
      throw new Error(
        `${label}: a database-backed value declares what its loader reads — the tables (\`reads: { tables, reason }\`), or the collections it \`follows\`.`,
      );
    }
    return typeof reads === "function" || deferredFollows
      ? defineDeferredResource(contract, () => routed(options, declaredNow()))
      : defineResource(contract, routed(options, reads));
  };
  const defineExternal = (contract: never, options: never) => {
    if (reads === undefined && follows === null) {
      return defineExternalResource(contract, options);
    }
    const { mode, freshness } = options as ServerResourceOptions<
      unknown,
      ResourceParams
    >;
    if (freshness?.kind !== "notified") {
      // Unreachable from typed code (`ExternalReadsOption` / `PagedReadsOption`).
      throw new Error(
        `${label}: \`reads\` is a "notified" value's — an immutable, fixed or snapshot value claims no push, so a write could tell it nothing.`,
      );
    }
    if ((contract as { keyed?: unknown }).keyed !== undefined) {
      // A paged value's pages: a keyed external window, which no scoped
      // route reaches (D31) — its reach plan is full-only, every reached
      // page re-read whole, like every other arm's.
      if (typeof reads === "function") {
        // Unreachable from typed code (`PagedReadsOption` takes no thunk).
        throw new Error(
          `${label}: a paged value's \`reads\` is a static list — its pages register at once, with no deferred bind for a thunk.`,
        );
      }
      if (deferredFollows) {
        throw new Error(
          `${label}: a paged value follows a collection compiled at boot (one folding exposures) — its pages register at once, with no deferred bind to copy that collection's routes at. Follow a collection compiled at once.`,
        );
      }
      return defineExternalResource(contract, routed(options, reads));
    }
    if (typeof reads !== "function" && !deferredFollows) {
      return defineExternalResource(contract, routed(options, reads));
    }
    // A deferred EXTERNAL value: external, with its mode and freshness, from
    // here on; its bind adds the plan once the registry the thunk reads (or
    // the deferred collection it follows) is complete.
    return defineDeferredResource(
      contract,
      () => routed(options, declaredNow()),
      {
        mode: mode as "push" | "invalidate",
        freshness,
      },
    );
  };
  return {
    defineResource: define as LiveRuntime["defineResource"],
    defineExternalResource:
      defineExternal as LiveRuntime["defineExternalResource"],
  };
}

/**
 * A paged value: its pages and — declared `paged.meta` — its meta sibling,
 * registered together over one per-question lifecycle (`serveValueOn`), each
 * declared.
 */
function servePaged(
  value: LivePagedValue<unknown, unknown, unknown, unknown>,
  opts: AnyServeOptions & {
    preloadParams?: unknown;
    reads?: AnyServedValueReads;
  },
): ServedPagedValue<unknown, unknown> | ServedSilentPagedValue<unknown> {
  if (opts.preloadParams !== undefined) {
    // Unreachable from typed code (a paged value is never preloaded).
    throw new Error(
      `serveValue("${value.key}"): a paged value is never preloaded — no \`preloadParams\`.`,
    );
  }
  const { meta, ...served } = serveValueOn(
    runtimeFor(value, opts),
    value,
    opts,
    { sources: "db+external" },
  );
  return {
    ...served,
    declare: [
      ResourceContribution.Declare({ key: served.key, mode: served.mode }),
      ...(meta === null
        ? []
        : [ResourceContribution.Declare({ key: meta.key, mode: meta.mode })]),
    ],
  } as ServedPagedValue<unknown, unknown> | ServedSilentPagedValue<unknown>;
}
