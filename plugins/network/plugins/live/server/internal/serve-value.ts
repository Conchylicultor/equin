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
} from "@plugins/network/plugins/live/core";
import { serveValueOn } from "../../core/internal/serve-on";
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
} from "../../core/internal/compile-value";

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
//   and the drift guard holds the loader to them as it holds a db value's.
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
 * whole tables and why, compiled to the value's routing plan. A thunk when the
 * tables come from a registry that is complete only once contributions are
 * collected (the value is then bound at `bindDeferredResources`, before the
 * change feed builds its triggers) — such a value must be pushed (`load` not
 * `"on-demand"`).
 */
export type ServedValueReads = ValueReads | (() => ValueReads);

/** The db arm's declaration of what its loader reads. Required. */
interface DbReadsOption {
  /** Every table the loader reads, and why a write to any row may change any tuple. */
  reads: ServedValueReads;
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
type ExternalReadsOption<C extends LiveValueChanges> = [C] extends ["notified"]
  ? {
      /** Every table the loader reads, and why a write to any row may change any tuple. */
      reads?: ServedValueReads;
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
export function serveValue<
  Item,
  Meta,
  Q,
  QIn,
  const R extends readonly ExternalServed[] = [],
  C extends PagedChanges = "notified",
  K extends string = never,
>(
  value: LivePagedValue<Item, Meta, Q, QIn, "worktree", K>,
  opts: ServePagedValueOptions<
    NoInfer<Item>,
    NoInfer<Meta>,
    NoInfer<Q>,
    R,
    C
  > & {
    /** A page is a keyed window, which no declared read reaches (D31). */
    reads?: never;
  },
): ServedFor<C, ServedPagedValue<Item, Q>, ServedSilentPagedValue<Item>>;
export function serveValue<
  T,
  Q,
  QIn,
  const R extends readonly ExternalServed[] = [],
>(
  value: LiveQueryValue<T, Q, QIn> &
    SnapshotPairing<"notified"> &
    BytesPairing<"db">,
  opts: ServeValueOptions<NoInfer<T>, NoInfer<Q>, "db", R> & DbReadsOption,
): ServedValue<T, LiveQueryParams>;
export function serveValue<
  T,
  Q,
  QIn,
  const R extends readonly ExternalServed[] = [],
  C extends LiveValueChanges = "notified",
>(
  value: LiveQueryValue<T, Q, QIn> & SnapshotPairing<C>,
  opts: ServeValueOptions<NoInfer<T>, NoInfer<Q>, "external", R, C> &
    ExternalReadsOption<C>,
): ServedFor<
  C,
  ServedExternalQueryValue<T, Q>,
  ServedValue<T, LiveQueryParams>
>;
export function serveValue<
  T,
  P extends Record<string, string>,
  const R extends readonly ExternalServed[] = [],
>(
  value: LivePreloadedParamValue<T, P>,
  opts: ServeValueOptions<NoInfer<T>, NoInfer<P>, "db", R> &
    DbReadsOption &
    PreloadParamsOption<NoInfer<P>>,
): ServedValue<T, P>;
export function serveValue<
  T,
  P extends Record<string, string>,
  const R extends readonly ExternalServed[] = [],
  C extends LiveValueChanges = "notified",
>(
  value: LivePreloadedParamValue<T, P> & SnapshotPairing<C>,
  opts: ServeValueOptions<NoInfer<T>, NoInfer<P>, "external", R, C> &
    PreloadParamsOption<NoInfer<P>> &
    ExternalReadsOption<C>,
): ServedFor<C, ServedExternalValue<T, P>, ServedValue<T, P>>;
export function serveValue<
  T,
  P extends Record<string, string>,
  const R extends readonly ExternalServed[] = [],
>(
  value: PlainValue<T, P> & SnapshotPairing<"notified"> & BytesPairing<"db">,
  opts: ServeValueOptions<NoInfer<T>, NoInfer<P>, "db", R> &
    DbReadsOption & {
      preloadParams?: never;
    },
): ServedValue<T, P>;
export function serveValue<
  T,
  P extends Record<string, string>,
  const R extends readonly ExternalServed[] = [],
  C extends LiveValueChanges = "notified",
>(
  value: PlainValue<T, P> & SnapshotPairing<C>,
  opts: ServeValueOptions<NoInfer<T>, NoInfer<P>, "external", R, C> &
    ExternalReadsOption<C> & {
      preloadParams?: never;
    },
): ServedFor<C, ServedExternalValue<T, P>, ServedValue<T, P>>;
export function serveValue<T, P extends Record<string, string>>(
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
    reads?: ServedValueReads;
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
    runtimeFor(value.key, opts),
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
  key: string,
  opts: { reads?: ServedValueReads },
): LiveRuntime {
  return valueRuntime(key, opts, SERVER_HOST);
}

/**
 * The runtime a value registers on: `host`'s, with a value's declared `reads`
 * compiled into the routing plan (`reach`) its registration carries — at once,
 * or at the host's `bindDeferredResources` for a thunk (an external one through
 * the runtime's deferred-external arm, so it is external, with its freshness,
 * from definition). Checked when the value registers, after its other options:
 * a db value without `reads`, and `reads` on an external value that is not
 * `"notified"` or on a paged value's keyed pages, are refused (tsc pairs them;
 * this is the untyped caller's check).
 */
export function valueRuntime(
  key: string,
  opts: { reads?: ServedValueReads },
  host: ValueHost,
): LiveRuntime {
  const { defineResource, defineDeferredResource, defineExternalResource } =
    host;
  const label = `serveValue("${key}")`;
  const { reads } = opts;
  const routed = (options: object, declared: ValueReads) =>
    ({
      ...options,
      reach: compiledValueReach(declared, label) as ReachPlan<ResourceParams>,
    }) as never;
  const define = (contract: never, options: object) => {
    if (reads === undefined) {
      throw new Error(
        `${label}: a database-backed value declares the tables its loader reads (\`reads: { tables, reason }\`).`,
      );
    }
    return typeof reads === "function"
      ? defineDeferredResource(contract, () => routed(options, reads()))
      : defineResource(contract, routed(options, reads));
  };
  const defineExternal = (contract: never, options: never) => {
    if (reads === undefined) return defineExternalResource(contract, options);
    if ((contract as { keyed?: unknown }).keyed !== undefined) {
      // Unreachable from typed code (`reads?: never` on the paged overload).
      throw new Error(
        `${label}: \`reads\` is a plain value's — a paged value's pages are keyed windows, which no declared read reaches.`,
      );
    }
    const { mode, freshness } = options as ServerResourceOptions<
      unknown,
      ResourceParams
    >;
    if (freshness?.kind !== "notified") {
      // Unreachable from typed code (`ExternalReadsOption`).
      throw new Error(
        `${label}: \`reads\` is a "notified" value's — an immutable, fixed or snapshot value claims no push, so a write could tell it nothing.`,
      );
    }
    if (typeof reads !== "function") {
      return defineExternalResource(contract, routed(options, reads));
    }
    // A deferred EXTERNAL value: external, with its mode and freshness, from
    // here on; its bind adds the plan once the registry the thunk reads is
    // complete.
    return defineDeferredResource(contract, () => routed(options, reads()), {
      mode: mode as "push" | "invalidate",
      freshness,
    });
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
    reads?: ServedValueReads;
  },
): ServedPagedValue<unknown, unknown> | ServedSilentPagedValue<unknown> {
  if (opts.preloadParams !== undefined) {
    // Unreachable from typed code (a paged value is never preloaded).
    throw new Error(
      `serveValue("${value.key}"): a paged value is never preloaded — no \`preloadParams\`.`,
    );
  }
  if (opts.reads !== undefined) {
    // Unreachable from typed code (`reads?: never` on the paged overload).
    throw new Error(
      `serveValue("${value.key}"): a paged value declares no \`reads\` — its pages are keyed windows, which no declared read reaches.`,
    );
  }
  const { meta, ...served } = serveValueOn(
    runtimeFor(value.key, opts),
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
