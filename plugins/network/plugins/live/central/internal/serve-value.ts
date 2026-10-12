import {
  defineExternalResource,
  defineResource,
} from "@plugins/framework/plugins/central-core/core";
import type {
  LivePagedParams,
  LivePagedPages,
  LivePagedValue,
  LiveQueryParams,
  LiveQueryValue,
  LiveValue,
} from "@plugins/network/plugins/live/core";
import {
  registerPagedOf,
  registerValueOf,
  type AnyServeOptions,
  type ExternalServed,
  type LiveValueChanges,
  type PagedChanges,
  type ServedFor,
  type ServedValueBase,
  type ServePagedValueOptions,
  type ServeValueOptions,
  type SnapshotPairing,
} from "../../shared/compile-value";

// `serveValue` on the CENTRAL runtime — the machine-wide process every worktree
// shares (auth). It takes only a value declared `origin: "central"` (a worktree
// value here is a tsc error, and the reverse), and only the external arm:
// central has no change feed, so its truth is always outside Postgres. As on
// the worktree, it declares `changes`: a `"notified"` value has `notify`, an
// immutable / fixed / snapshot one has none.
//
// Registration is the central plugin definition's `resources: [served]` — the
// central runtime has no `Resource.Declare` contribution, so there is no
// `declare` tuple here. Options compile in `../../shared/compile-value`, the same
// code the worktree `serveValue` runs.

/** A value served by the central runtime with no change signal (immutable / fixed / snapshot). */
export type CentralSilentValue<
  T,
  P extends Record<string, string>,
> = ServedValueBase<T, P> & {
  source: "external";
  changes: LiveValueChanges;
};

/** A `changes: "notified"` value served by the central runtime: the runtime resource plus `notify`. */
export type CentralServedValue<
  T,
  P extends Record<string, string>,
> = CentralSilentValue<T, P> & {
  /** The truth changed: recompute (and push) this tuple — `{}` when omitted. */
  notify(params?: P): void;
};

/** A central typed-query value: `notify(query)` reaches its question's tuple. */
export type CentralServedQueryValue<
  T,
  P extends Record<string, string>,
  Q,
> = CentralSilentValue<T, P> & {
  notify(query: Q): void;
};

/**
 * A central paged value: its pages' resource, `notify(query)` reaching every
 * subscribed page of the question and its meta, and `meta` — the meta
 * sibling's resource (declared `paged.meta`), which the central plugin
 * registers beside it: `resources: [served, served.meta]`.
 */
export type CentralServedPagedValue<Item, Q> = CentralSilentPagedValue<Item> & {
  notify(query: Q): void;
};

/** A central paged value declared `changes: { immutable | fixed }`: no `notify`. */
export type CentralSilentPagedValue<Item> = ServedValueBase<
  Item[],
  LivePagedParams
> & {
  source: "external";
  changes: LiveValueChanges;
  meta: ServedValueBase<unknown, LiveQueryParams> | null;
};

/**
 * Serve a central `liveValue`.
 *
 * ```ts
 * export const authStateServed = serveValue(authState, {
 *   source: "external",
 *   changes: "notified",
 *   loader: computeAuthState,
 * });
 * // central plugin definition: resources: [authStateServed]
 * authStateServed.notify();
 * ```
 */
export function serveValue<
  Item,
  Meta,
  Q,
  QIn,
  const R extends readonly ExternalServed[] = [],
  C extends PagedChanges = "notified",
>(
  value: LivePagedValue<Item, Meta, Q, QIn, "central">,
  opts: ServePagedValueOptions<NoInfer<Item>, NoInfer<Meta>, NoInfer<Q>, R, C>,
): ServedFor<
  C,
  CentralServedPagedValue<Item, Q>,
  CentralSilentPagedValue<Item>
>;
export function serveValue<
  T,
  Q,
  QIn,
  const R extends readonly ExternalServed[] = [],
  C extends LiveValueChanges = "notified",
>(
  value: LiveQueryValue<T, Q, QIn, "central"> & SnapshotPairing<C>,
  opts: ServeValueOptions<NoInfer<T>, NoInfer<Q>, "external", R, C>,
): ServedFor<
  C,
  CentralServedQueryValue<T, LiveQueryParams, Q>,
  CentralSilentValue<T, LiveQueryParams>
>;
export function serveValue<
  T,
  P extends Record<string, string>,
  const R extends readonly ExternalServed[] = [],
  C extends LiveValueChanges = "notified",
>(
  value: LiveValue<T, P, "central"> & {
    query?: undefined;
  } & SnapshotPairing<C>,
  opts: ServeValueOptions<NoInfer<T>, NoInfer<P>, "external", R, C>,
): ServedFor<C, CentralServedValue<T, P>, CentralSilentValue<T, P>>;
export function serveValue<T, P extends Record<string, string>>(
  value:
    | (LiveValue<T, P, "central"> & { query?: unknown; paged?: unknown })
    // biome-ignore lint/suspicious/noExplicitAny: a generic item's schema is invariant — erased, as page-source's `AnyPagedValue` is.
    | LivePagedPages<any, any, any, "central">,
  opts: AnyServeOptions,
):
  | CentralServedValue<T, P>
  | CentralServedQueryValue<T, P, unknown>
  | CentralSilentValue<T, P>
  | CentralServedPagedValue<unknown, unknown>
  | CentralSilentPagedValue<unknown> {
  if ((opts.source as string) !== "external") {
    // Unreachable from typed code: the only arm is external.
    throw new Error(
      `serveValue("${value.key}"): a central value must be source "external" — central has no change feed.`,
    );
  }
  // A paged value's pages are the one keyed value (a keyed window each).
  if (value.keyed !== undefined) {
    return servePaged(
      value as unknown as LivePagedValue<
        unknown,
        unknown,
        unknown,
        unknown,
        "central"
      >,
      opts,
    );
  }
  // Erased: the overloads checked the options against the declaration's
  // form, and the compilation dispatches on the declaration itself.
  const { resource, compiled } = registerValueOf<T, P, unknown>(
    { defineResource, defineExternalResource },
    value,
    opts,
  );
  if (!("notify" in resource)) {
    throw new Error(
      `serveValue("${value.key}"): the external arm registered no notify.`,
    );
  }
  const changes = compiled.changes;
  if (changes === undefined) {
    // Unreachable: the external arm's `changes` is checked at compile.
    throw new Error(`serveValue("${value.key}"): no \`changes\` declared.`);
  }
  const base: CentralSilentValue<T, P> = {
    key: resource.key,
    mode: resource.mode,
    schema: resource.schema,
    ...(resource.preload !== undefined ? { preload: resource.preload } : {}),
    load: (params: P) => resource.load(params),
    source: "external",
    changes,
    keys: [value.key],
  };
  // No change signal ⇒ no `notify`, at runtime too.
  if (changes !== "notified") return base;
  return {
    ...base,
    // Only the params: `affectedIds` is a keyed concept. A query or paged
    // value is notified by its QUESTION (see the worktree `serveValue`).
    notify:
      (value as { query?: unknown }).query !== undefined
        ? (query?: unknown) => {
            for (const tuple of compiled.tuplesOf(query))
              resource.notify(tuple);
          }
        : (params?: P) => resource.notify(params),
  };
}

/** A central paged value: its pages and meta sibling over one per-question lifecycle. */
function servePaged(
  value: LivePagedValue<unknown, unknown, unknown, unknown, "central">,
  opts: AnyServeOptions,
): CentralServedPagedValue<unknown, unknown> | CentralSilentPagedValue<unknown> {
  const { resource, compiled, meta } = registerPagedOf(
    { defineResource, defineExternalResource },
    value,
    opts,
  );
  const changes = compiled.changes;
  if (changes === undefined) {
    // Unreachable: the external arm's `changes` is checked at compile.
    throw new Error(`serveValue("${value.key}"): no \`changes\` declared.`);
  }
  const base: CentralSilentPagedValue<unknown> = {
    key: resource.key,
    mode: resource.mode,
    schema: resource.schema,
    load: (params: LivePagedParams) => resource.load(params),
    source: "external",
    changes,
    keys: [value.key, ...(meta === null ? [] : [meta.resource.key])],
    meta:
      meta === null
        ? null
        : {
            key: meta.resource.key,
            mode: meta.resource.mode,
            schema: meta.resource.schema,
            load: (params: LiveQueryParams) => meta.resource.load(params),
            source: "external",
            changes,
            keys: [meta.resource.key],
          },
  };
  // No change signal ⇒ no `notify`, at runtime too.
  if (changes !== "notified") return base;
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
