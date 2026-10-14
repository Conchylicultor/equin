import {
  defineExternalResource,
  defineResource,
} from "@plugins/framework/plugins/central-core/core";
import {
  type LivePagedPages,
  type LivePagedValue,
  type LiveQueryParams,
  type LiveQueryValue,
  type LiveValue,
} from "@plugins/network/plugins/live/core";
import {
  serveValueOn,
  type ExternalNotifiedPagedValue,
  type ExternalNotifiedQueryValue,
  type ExternalNotifiedValue,
  type ExternalSilentPagedValue,
  type ExternalSilentValue,
} from "../../core/internal/serve-on";
import type {
  AnyServeOptions,
  ExternalServed,
  LiveValueChanges,
  PagedChanges,
  ServedFor,
  ServePagedValueOptions,
  ServeValueOptions,
  SnapshotPairing,
} from "../../core/internal/compile-value";

// `serveValue` on the CENTRAL runtime — the machine-wide process every worktree
// shares (auth). It takes only a value declared `origin: "central"` (a worktree
// value here is a tsc error, and the reverse), and only the external arm:
// central has no change feed, so its truth is always outside Postgres. As on
// the worktree, it declares `changes`: a `"notified"` value has `notify`, an
// immutable / fixed / snapshot one has none.
//
// Registration is the central plugin definition's `resources: [served]` — the
// central runtime has no `Resource.Declare` contribution, so there is no
// `declare` tuple here. The body is the core's `serveValueOn` on central-core's
// runtime, `sources: "external"` — the same code the worktree `serveValue`
// runs, which refuses a cast past the external arm.

// The served shapes are the external arm's, shared with every host that
// serves it (`core/internal/serve-on.ts`).

/** A value served by the central runtime with no change signal (immutable / fixed / snapshot). */
export type CentralSilentValue<
  T,
  P extends Record<string, string>,
> = ExternalSilentValue<T, P>;

/** A `changes: "notified"` value served by the central runtime: the runtime resource plus `notify`. */
export type CentralServedValue<
  T,
  P extends Record<string, string>,
> = ExternalNotifiedValue<T, P>;

/** A central typed-query value: `notify(query)` reaches its question's tuple. */
export type CentralServedQueryValue<
  T,
  P extends Record<string, string>,
  Q,
> = ExternalNotifiedQueryValue<T, P, Q>;

/**
 * A central paged value: its pages' resource, `notify(query)` reaching every
 * subscribed page of the question and its meta, and `meta` — the meta
 * sibling's resource (declared `paged.meta`), which the central plugin
 * registers beside it: `resources: [served, served.meta]`.
 */
export type CentralServedPagedValue<Item, Q> = ExternalNotifiedPagedValue<
  Item,
  Q
>;

/** A central paged value declared `changes: { immutable | fixed }`: no `notify`. */
export type CentralSilentPagedValue<Item> = ExternalSilentPagedValue<Item>;

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
  K extends string = never,
>(
  value: LivePagedValue<Item, Meta, Q, QIn, "central", K>,
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
  // Erased: the overloads checked the options against the declaration's
  // form, and the compilation dispatches on the declaration itself.
  return serveValueOn(
    { defineResource, defineExternalResource },
    value as LiveValue<T, P, "central">,
    opts as AnyServeOptions & { source: "external" },
    { sources: "external" },
  ) as
    | CentralServedValue<T, P>
    | CentralServedQueryValue<T, P, unknown>
    | CentralSilentValue<T, P>
    | CentralServedPagedValue<unknown, unknown>
    | CentralSilentPagedValue<unknown>;
}
