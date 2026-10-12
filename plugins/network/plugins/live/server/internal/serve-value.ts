import {
  defineExternalResource,
  defineResource,
  Resource as ResourceContribution,
} from "@plugins/framework/plugins/server-core/core";
import type {
  LivePagedParams,
  LivePagedPages,
  LivePagedValue,
  LivePreloadedParamValue,
  LiveQueryParams,
  LiveQueryValue,
  LiveValue,
} from "@plugins/network/plugins/live/core";
import { canonicalParams } from "@plugins/packages/plugins/canonical-params/core";
import {
  registerPagedOf,
  registerValueOf,
  type AnyServeOptions,
  type BytesPairing,
  type ExternalServed,
  type LiveValueChanges,
  type PagedChanges,
  type ServedFor,
  type ServedValueBase,
  type ServePagedValueOptions,
  type ServeValueOptions,
  type SnapshotPairing,
} from "../../shared/compile-value";

// `serveValue` — the server half of a worktree `liveValue`. It declares WHERE the
// value's truth lives (`source`) and how to read it (`loader`), never a delivery
// mode: a value is pushed whole whenever it changes, unless its `liveValue`
// declaration opts into `load: "on-demand"` (declared there because the client
// reads it too).
//
// - `source: "db"` — the truth is Postgres. The read-set is captured at the DB
//   pool chokepoint, and a change to any table the loader read recomputes every
//   subscribed tuple (a FULL recompute — no scope policy: a value is one
//   payload, a keyed payload is a collection). There is no `notify`.
// - `source: "external"` — the truth lives outside Postgres (git, files, an
//   in-memory registry), which no change feed can see. It must declare how its
//   answer changes (`changes`, `LiveValueChanges`): `"notified"` — the served
//   value has `notify(params?)`, and nothing else does — or an immutable,
//   fixed or snapshot answer, with its reason and no `notify`.
//
// The options (`throttleMs`, `recomputeOn`, `whileSubscribed`, `revalidate`, …)
// compile in `../../shared/compile-value`, shared with the central `serveValue`.

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
  opts: ServePagedValueOptions<NoInfer<Item>, NoInfer<Meta>, NoInfer<Q>, R, C>,
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
  opts: ServeValueOptions<NoInfer<T>, NoInfer<Q>, "db", R>,
): ServedValue<T, LiveQueryParams>;
export function serveValue<
  T,
  Q,
  QIn,
  const R extends readonly ExternalServed[] = [],
  C extends LiveValueChanges = "notified",
>(
  value: LiveQueryValue<T, Q, QIn> & SnapshotPairing<C>,
  opts: ServeValueOptions<NoInfer<T>, NoInfer<Q>, "external", R, C>,
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
    PreloadParamsOption<NoInfer<P>>,
): ServedFor<C, ServedExternalValue<T, P>, ServedValue<T, P>>;
export function serveValue<
  T,
  P extends Record<string, string>,
  const R extends readonly ExternalServed[] = [],
>(
  value: PlainValue<T, P> & SnapshotPairing<"notified"> & BytesPairing<"db">,
  opts: ServeValueOptions<NoInfer<T>, NoInfer<P>, "db", R> & {
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
  opts: ServeValueOptions<NoInfer<T>, NoInfer<P>, "external", R, C> & {
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
  const { resource, compiled } = registerValueOf<T, P, unknown>(
    { defineResource, defineExternalResource },
    value,
    opts,
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
                value: await resource.load(params),
              });
            } catch (error) {
              out.push({ params, ok: false, error });
            }
          }
          return out;
        };
  const base = {
    key: resource.key,
    mode: resource.mode,
    schema: resource.schema,
    ...(resource.preload !== undefined ? { preload: resource.preload } : {}),
    load: (params: P) => resource.load(params),
    source: opts.source,
    ...(compiled.changes !== undefined ? { changes: compiled.changes } : {}),
    ...(compiled.unbounded !== undefined
      ? { unbounded: compiled.unbounded }
      : {}),
    keys: [value.key],
    declare: [
      ResourceContribution.Declare({
        key: resource.key,
        mode: resource.mode,
        ...(resource.preload !== undefined
          ? { preload: resource.preload }
          : {}),
        ...(preloadTuples !== undefined ? { preloadTuples } : {}),
      }),
    ] as [ReturnType<typeof ResourceContribution.Declare>],
  };
  if ("notify" in resource && compiled.changes === "notified") {
    const queried = value.query !== undefined;
    const served: ServedExternalValue<T, P> = {
      ...base,
      // Only the params: `affectedIds` is a keyed concept. The runtime
      // canonicalizes them, so a notify reaches the tuple a read subscribed
      // however an absent optional param is spelled (`undefined`, `""`, left out).
      // A query value is notified by its QUESTION, which reaches the one
      // tuple the codec spells it as.
      notify: queried
        ? (query?: unknown) => {
            for (const tuple of compiled.tuplesOf(query))
              resource.notify(tuple);
          }
        : (params?: P) => resource.notify(params),
    };
    return served;
  }
  // A fresh object rather than the runtime's own: that one carries a working
  // `notify` its type merely hides, and a Postgres-backed value is driven by the
  // change feed alone — so the db arm has no `notify`, at runtime too; nor has
  // an immutable, fixed or snapshot external value (no change signal).
  const served: ServedValue<T, P> = base;
  return served;
}

/**
 * A paged value: its pages and — declared `paged.meta` — its meta sibling,
 * registered together over one per-question lifecycle (`registerPagedOf`).
 */
function servePaged(
  value: LivePagedValue<unknown, unknown, unknown, unknown>,
  opts: AnyServeOptions & { preloadParams?: unknown },
): ServedPagedValue<unknown, unknown> | ServedSilentPagedValue<unknown> {
  if (opts.preloadParams !== undefined) {
    // Unreachable from typed code (a paged value is never preloaded).
    throw new Error(
      `serveValue("${value.key}"): a paged value is never preloaded — no \`preloadParams\`.`,
    );
  }
  const { resource, compiled, meta } = registerPagedOf(
    { defineResource, defineExternalResource },
    value,
    opts,
  );
  const declarations = [
    ResourceContribution.Declare({ key: resource.key, mode: resource.mode }),
    ...(meta === null
      ? []
      : [
          ResourceContribution.Declare({
            key: meta.resource.key,
            mode: meta.resource.mode,
          }),
        ]),
  ];
  const base: ServedSilentPagedValue<unknown> = {
    key: resource.key,
    mode: resource.mode,
    schema: resource.schema,
    load: (params: LivePagedParams) => resource.load(params),
    source: "external",
    ...(compiled.changes !== undefined ? { changes: compiled.changes } : {}),
    keys: [value.key, ...(meta === null ? [] : [meta.resource.key])],
    declare: declarations,
  };
  // Only a `"notified"` value is told of a change (see `serveValue`).
  if (compiled.changes !== "notified") return base;
  return {
    ...base,
    notify(query: unknown) {
      for (const tuple of compiled.tuplesOf(query)) resource.notify(tuple);
      if (meta === null) return;
      for (const tuple of meta.compiled.tuplesOf(query)) {
        meta.resource.notify(tuple);
      }
    },
  };
}
