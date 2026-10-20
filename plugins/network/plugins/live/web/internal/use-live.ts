import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { canonicalParams } from "@plugins/packages/plugins/canonical-params/core";
import {
  useResource,
  useResources,
  type PagedResourceResult,
  type ResourceDescriptor,
  type ResourceError,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import type {
  LiveAllCollection,
  LiveCollection,
  LiveCountedCollection,
  LiveCountQuery,
  LiveGroup,
  LiveGroupableColumn,
  LiveGroupQuery,
  LiveGroupValue,
  LiveQuery,
  LivePagedPages,
  LivePagedValue,
  LivePlainValue,
  LiveQueryValue,
  LiveRowsCollection,
  LiveValue,
  LiveValueOrigin,
} from "@plugins/network/plugins/live/core";
import {
  isPointId,
  type CollectionRow,
} from "@plugins/network/plugins/live/core";
import { useTransport } from "@plugins/primitives/plugins/networking/web";
import {
  unavailableMessage,
  type MachineFeature,
} from "@plugins/infra/plugins/endpoints/core";
import {
  useAllPages,
  useValuePages,
  useViewportPages,
  type LivePagesOptions,
  type LivePagesResult,
  type LiveValuePagesOptions,
} from "./use-pages";
import type { LivePagesQuery } from "./page-source";

// The read half of a `liveCollection`. A consumer asks a QUERY — a window
// (`where` / `orderBy` / `limit`), a grouping (`groupBy`) or an explicit id set
// — and never picks the wire resource or its params: the window goes to `key`,
// a grouping to `:groups`, an id set to the `:rows` point sibling, and the
// encoding is the declaration's own codec. A window is read as key-range
// pages; a grouping shares the window's list result, grown by its limit; only
// a read whose result has different STATES (`useLiveRow`) gets its own hook.
// A `liveValue` is read by the same hook: its result is `ResourceResult<T>`,
// the states every read already has, so it gets no hook of its own.

/**
 * A list read: the paged read every grow-able read with no viewport returns,
 * never past `maxLimit` rows. A collection's window or a paged value is read
 * as key-range pages, every one live: `loadMore()` splits the last page, and
 * a page that fails under the rows shown is the error arm with them as
 * `stale`. A grouping is one tuple whose limit grows: `canGrow` is "the list
 * is full and below `maxLimit`", `loadMore()` grows it by one default page
 * (clamped to `maxLimit`), and a grow that FAILS is the error arm with the
 * list it grew from as `stale`.
 */
export type LiveListResult<
  Row,
  C extends string = string,
> = PagedResourceResult<Row, C>;

/**
 * A read of a value declared `load: "snapshot"`: its result plus `refresh()`
 * — re-measure NOW. A snapshot is never told of a change, so this is the only
 * way its answer moves: an HTTP read that always runs the loader (the server
 * keeps no `revalidate` for it). Typed only on a snapshot read — a value that
 * is kept live has nothing to refresh.
 */
export type LiveSnapshotResult<T, C extends string = string> = ResourceResult<
  T,
  C
> & {
  refresh: () => Promise<void>;
};

/**
 * The refusal codes a value declares (`liveValue`'s `refusals`), as the
 * parameter side of a value overload infers them: a read's `refused` error
 * carries one (`error.code`), typed by the declaration. `never` for a value
 * that declares none — it is never refused.
 */
interface RefusalsDecl<C extends string> {
  refusals?: readonly C[];
}

/** The brand a snapshot declaration carries (see `LiveSnapshotBrand`). */
interface SnapshotDecl {
  snapshot: true;
}

/**
 * The read of a declaration that needs the computer (`needsMachine`) under a
 * transport with none behind it (an in-browser server): nothing is read, and
 * `message` is the sentence to show in its place. A state of its own — never
 * `loading` (it will not arrive) nor `error` (nothing failed).
 */
export interface LiveUnavailable {
  status: "unavailable";
  message: string;
}

/**
 * A declaration's `needsMachine`, as the parameter side of an overload infers
 * it: `MachineFeature` for a declaration that needs the computer, `undefined`
 * (or nothing to infer from — the default) for a portable one.
 */
interface MachineDecl<M> {
  needsMachine?: M;
}

/**
 * A read's result, plus the {@link LiveUnavailable} arm exactly when its
 * declaration needs the computer — so a reader of such a declaration cannot
 * reach `data` without first handling the arm, and a portable read's type is
 * unchanged.
 */
export type WithMachine<M, R> = [M] extends [MachineFeature]
  ? R | LiveUnavailable
  : R;

/** An explicit id set. Rows come back for the ids that exist; no filter applies. */
export interface LiveIdsQuery {
  ids: readonly string[];
}

/**
 * A derived slice of a collection declared `all` (`useLive(all, { select })`).
 * The read re-renders only when the SELECTED value changes (structurally
 * compared), so a reader of one fact about the set (a count, one row's field)
 * is not re-rendered by a push that leaves that fact alone. Pass a stable
 * function (`useCallback`, or one at module level): a new one each render is
 * re-run each render.
 */
export interface LiveAllSelect<Row, S> {
  select: (rows: Row[]) => S;
}

/**
 * The scope of a collection declared `all: { by }` (`useLive(c, { where })`):
 * exactly its `by` fields, each a string — a `Filter` tree, an op, a missing
 * or an extra field is a tsc error. The record IS the tuple's params. `never`
 * for a set declared without `by`, which has one tuple.
 */
export type LiveScopedAllQuery<B extends string> = [B] extends [never]
  ? never
  : { where: { readonly [K in B]: string } };

/**
 * One row by id: loading, failed, found, or determinately absent — `ready`
 * splits on `found`. `pending` is the pre-`status` spelling (see
 * `ResourceResult`), kept while the tree migrates.
 */
export type LiveRowResult<Row> =
  | {
      status: "loading";
      refetch: () => Promise<void>;
    }
  | {
      status: "error";
      error: ResourceError;
      /** The row as last seen, if it was ever seen. */
      stale?: Row;
      refetch: () => Promise<void>;
    }
  | {
      status: "ready";
      found: true;
      row: Row;
      refetch: () => Promise<void>;
    }
  | {
      status: "ready";
      found: false;
      refetch: () => Promise<void>;
    };

type AnyDescriptor = ResourceDescriptor<unknown, Record<string, string>>;

/**
 * A grouping query, reduced to what the grow logic needs: the resource, how
 * to encode it at a given limit, the limit asked for, and the step / cap a
 * grow moves by. `base` (the query WITHOUT its limit, canonically encoded)
 * identifies which list a grow belongs to.
 */
interface GroupShape {
  descriptor: AnyDescriptor;
  base: string;
  encode: (limit: number) => Record<string, string>;
  askedLimit: number;
  step: number;
  maxLimit: number;
}

function groupShape<Row, F, S extends string>(
  collection: LiveCollection<Row, F, S>,
  query: LiveGroupQuery<F>,
): GroupShape {
  const codec = collection.groups.groups;
  // The WHOLE query goes to the codec (limit replaced), so a stray `orderBy`
  // from an untyped caller throws there instead of being dropped here.
  const encode = (limit: number) => codec.encode({ ...query, limit });
  return {
    descriptor: collection.groups as AnyDescriptor,
    // `groupBy` rides in `base`, so a grow never outlives a change of column.
    base: JSON.stringify(encode(1)),
    encode,
    askedLimit: query.limit ?? codec.defaultLimit,
    step: codec.defaultLimit,
    maxLimit: codec.maxLimit,
  };
}

/**
 * Read a live collection. The QUERY's shape picks what is read — a consumer
 * never names a wire resource or its params.
 *
 * - `useLive(c)` / `useLive(c, { where, orderBy, limit })` — a bounded window,
 *   read as key-range pages, every one live (page 0 is this window tuple —
 *   the one boot hydrates). Its settled arm adds `canGrow` / `growing` /
 *   `loadMore()`: `loadMore()` splits the last page (one new page, seeded —
 *   never a reload of a larger window), and it never pages past `maxLimit`
 *   rows. While a new page loads the hook STAYS settled on the rows it has
 *   (`growing: true`), so `if (pending)` never flashes a spinner over a list
 *   that already rendered. Under a viewport, see below.
 * - `useLive(c, { groupBy, where?, limit? })` — the values a text / number /
 *   boolean filterable column takes (with counts), ordered by count desc then
 *   value; each value typed as the row field. The same list result as a
 *   window, but one tuple whose limit grows: `loadMore()` reloads the
 *   grouping at one more page of groups, and while the grown one loads the
 *   hook stays settled on the previous groups (`growing: true`).
 * - `useLive(c, { count: true, where? })` — how many rows match `where`, as
 *   `ResourceResult<number>`, kept live; only on a collection declared
 *   `count: true`. `null` in place of the query (or of both) reads nothing
 *   (pending) — for a surface whose count is not cheap right now (a search is
 *   on), or that has no collection to count.
 * - `useLive(c, { ids })` — an explicit id set, via the `:rows` point sibling.
 *   No paging fields: an id set is not a window. The one list-free read, so it
 *   (and `useLiveRow`) also takes a lookup-only collection; a window or
 *   grouping read of one is a tsc error — it declares no order to list in.
 */
/**
 * A value's params argument: absent for a param-less value (`P` is
 * `Record<string, never>` — no declared name), required otherwise — the
 * declared names (each a string, an optional one may be left out), or `null`
 * when there is no subject to read yet.
 */
type LiveValueArgs<P> = string extends keyof P
  ? []
  : [keyof P] extends [never]
    ? []
    : [params: P | null];

/**
 * A value's tuple LIST (`useLive(v, [p1, p2, …])`): the params of a param'd
 * value, each `null` for a tuple with no subject yet (skipped). `never` for a
 * param-less value — it has one tuple, read with `useLive(v)`.
 */
type LiveValueParamsList<P> = string extends keyof P
  ? never
  : [keyof P] extends [never]
    ? never
    : readonly (P | null)[];

/**
 * A typed-query value's question LIST — never for a question that is itself
 * an array (the declaration refuses one too: it would read as a list).
 */
type LiveQueryList<QIn> = QIn extends readonly unknown[]
  ? never
  : readonly (QIn | null)[];

/**
 * One tuple's read in a list read: a snapshot value's adds `refresh()`, as its
 * single read does. `V` is the declaration as passed (its brand decides).
 */
type LiveValueRead<V, T, C extends string> = V extends SnapshotDecl
  ? LiveSnapshotResult<T, C>
  : ResourceResult<T, C>;

// The window overload comes FIRST: an argument like `where: or(...)` is a
// generic call TypeScript checks once, against the first overload's contextual
// type — so that type must be the collection's own `LiveWhere` for the tree's
// columns and operands to be checked against the declaration.
export function useLive<
  Row,
  F,
  S extends string,
  NM extends MachineFeature | undefined = undefined,
>(
  collection: LiveCollection<Row, F, S> & MachineDecl<NM>,
  query?: LiveQuery<F, S>,
): WithMachine<NM, LiveListResult<CollectionRow<Row>>>;
export function useLive<
  Row,
  F,
  S extends string,
  const G extends LiveGroupableColumn<F>,
  NM extends MachineFeature | undefined = undefined,
>(
  collection: LiveCollection<Row, F, S> & MachineDecl<NM>,
  query: LiveGroupQuery<F, G>,
): WithMachine<NM, LiveListResult<LiveGroup<LiveGroupValue<Row, G>>>>;
export function useLive<
  Row,
  F,
  S extends string,
  NM extends MachineFeature | undefined = undefined,
>(
  collection: (LiveCountedCollection<Row, F, S> & MachineDecl<NM>) | null,
  query: LiveCountQuery<F> | null,
): WithMachine<NM, ResourceResult<number>>;
/**
 * - `useLive(c, query, { viewport, resetKey? })` — a collection's window read
 *   with no depth limit, its key-range pages kept live by the rows a surface
 *   has on screen (`viewport`, a branded `VisibleRange` only data-view mints):
 *   `LivePagesResult<Row>`, with per-page errors and the placeholders past the
 *   stale budget. `query` has no `limit` (the pages own the limits); `null`
 *   for both reads nothing (loading) with the hook order kept.
 *
 *   Without a viewport, `useLive(c, query?)` is the window overload above,
 *   read as the same pages, every one live: `loadMore()` splits the last
 *   page, and never pages past `maxLimit` rows.
 */
export function useLive<
  Row,
  F,
  S extends string,
  NM extends MachineFeature | undefined = undefined,
>(
  collection: (LiveCollection<Row, F, S> & MachineDecl<NM>) | null,
  query: LivePagesQuery<F, S> | null,
  options: LivePagesOptions,
): WithMachine<NM, LivePagesResult<CollectionRow<Row>>>;
/**
 * - `useLive(all)` — a collection declared `all`: every row, in its declared
 *   order, as `ResourceResult<Row[]>` (settled on its first render when the
 *   boot snapshot hydrated it). Read straight off the cache with no row map
 *   and no selector, so `data` IS the cached array — every observer shares it
 *   and its row objects — keeps its identity until a push changes the set, and
 *   a delta keeps the identity of every row it does not change, moved ones
 *   included — consumers memoize on both.
 * - `useLive(all, { select })` — a slice of it (`LiveAllSelect`), re-rendered
 *   only when the slice changes. Gated: its first value always renders,
 *   whatever the slice.
 *
 * - `useLive(scoped, { where: { pageId } })` — a collection declared
 *   `all: { by }`: every row OF ONE SCOPE, in the declared order (the
 *   `where` record is its tuple: exactly the `by` fields — `LiveScopedAllQuery`);
 *   with `select`, a slice of it. Read and gated exactly like the whole set;
 *   a scope change is a new tuple (loading). `useLive(scoped)` without one is
 *   a tsc error, and a `where` on a set without `by` too (both throw for an
 *   untyped caller).
 *
 * An id set of an `all` collection is `useLive(all, { ids })` /
 * `useLiveRow(all, id)`, through its `:rows` point sibling like any other —
 * global, whatever the scope.
 * These overloads come AFTER the window and group ones (an `all` collection
 * has neither, so it never matches them) so a window query's contextual type
 * is still the first overload's.
 */
export function useLive<Row, NM extends MachineFeature | undefined = undefined>(
  collection: LiveAllCollection<Row> & MachineDecl<NM>,
): WithMachine<NM, ResourceResult<CollectionRow<Row>[]>>;
export function useLive<
  Row,
  S,
  NM extends MachineFeature | undefined = undefined,
>(
  collection: LiveAllCollection<Row> & MachineDecl<NM>,
  options: LiveAllSelect<Row, S>,
): WithMachine<NM, ResourceResult<S>>;
// The selected form first: a `{ where, select }` literal would otherwise be
// tried against the plain one (its `select` an excess property).
export function useLive<
  Row,
  B extends string,
  S,
  NM extends MachineFeature | undefined = undefined,
>(
  collection: LiveAllCollection<Row, B> & MachineDecl<NM>,
  query: LiveScopedAllQuery<NoInfer<B>> & LiveAllSelect<Row, S>,
): WithMachine<NM, ResourceResult<S>>;
export function useLive<
  Row,
  B extends string,
  NM extends MachineFeature | undefined = undefined,
>(
  collection: LiveAllCollection<Row, B> & MachineDecl<NM>,
  query: LiveScopedAllQuery<NoInfer<B>>,
): WithMachine<NM, ResourceResult<CollectionRow<Row>[]>>;
export function useLive<Row, NM extends MachineFeature | undefined = undefined>(
  collection: LiveRowsCollection<Row> & MachineDecl<NM>,
  query: LiveIdsQuery,
): WithMachine<NM, ResourceResult<CollectionRow<Row>[]>>;
/**
 * - `useLive(value)` / `useLive(value, params)` — a declared `liveValue`:
 *   `ResourceResult<T>` (pending, then settled; settled on its first render
 *   when the boot snapshot preloaded it). `params` is required exactly when the
 *   value declares params. A central value (`origin: "central"`) reads the
 *   same way; its descriptor routes the subscription to the central socket.
 * - `useLive(value, null)` — a param'd value whose subject has not ARRIVED yet
 *   (an id another read is still loading): `pending` with no error for as long
 *   as it is `null`, and nothing is read — no subscription, no HTTP read, not a
 *   pending mount. A value whose subject is not known yet is not known yet;
 *   one that will NEVER arrive (a missing registration, a legacy record with no
 *   id) is a settled answer the caller renders or throws on itself, never a
 *   `null` read left spinning.
 */
/**
 * - `useLive(value, [p1, p2, …])` / `useLive(queryValue, [q1, q2, …])` — MANY
 *   tuples of one value (a dynamic set: the expanded folders of a tree, a peek
 *   per row): an ARRAY of params (or of questions) → one result per entry, in
 *   order, each exactly the single read's (`ResourceResult<T, C>`, plus
 *   `refresh()` for a snapshot value). A `null` entry is a skip — `loading`,
 *   nothing read — like `useLive(v, null)`. The set moves by diff: a tuple
 *   kept across a change (moved, or with others added or removed around it)
 *   stays subscribed and keeps its settled result; the same tuple listed twice
 *   is read once. An object is always the single-tuple form, so the two never
 *   overlap; a param-less value has no list form. These overloads sit
 *   before every single value overload, so a call matching none is still
 *   reported against the last one — the plain single read.
 */
export function useLive<
  T,
  Q,
  QIn,
  C extends string = never,
  V extends object = object,
  NM extends MachineFeature | undefined = undefined,
>(
  value: LiveQueryValue<T, Q, QIn, LiveValueOrigin> &
    RefusalsDecl<C> &
    MachineDecl<NM> &
    V,
  queries: LiveQueryList<NoInfer<QIn>>,
): WithMachine<NM, readonly LiveValueRead<V, T, C>[]>;
export function useLive<
  T,
  P extends Record<string, string>,
  C extends string = never,
  V extends object = object,
  NM extends MachineFeature | undefined = undefined,
>(
  value: LivePlainValue<T, P, LiveValueOrigin> &
    RefusalsDecl<C> &
    MachineDecl<NM> &
    V,
  params: LiveValueParamsList<NoInfer<P>>,
): WithMachine<NM, readonly LiveValueRead<V, T, C>[]>;
/**
 * - `useLive(pagedValue, query, { viewport, resetKey? })` — a key-range-paged
 *   value (`liveValue(key, { query, paged })`) read like a collection's window
 *   under a viewport: `LivePagesResult<Item>`, no depth limit. `null` for
 *   both reads nothing (loading).
 * - `useLive(pagedValue, query, { limit? })` — no viewport: every page live,
 *   capped at `paged.maxLimit` items, `LiveListResult<Item>`; `limit` is page
 *   0's (a preview) and the step `loadMore()` grows by. `null` reads nothing.
 *   The per-question meta sibling is `useLive(pagedValue.meta, query)`.
 */
export function useLive<
  Item,
  Meta,
  Q,
  QIn,
  C extends string = never,
  NM extends MachineFeature | undefined = undefined,
>(
  value: LivePagedValue<Item, Meta, Q, QIn, LiveValueOrigin, C, NM> | null,
  query: NoInfer<QIn> | null,
  options: LivePagesOptions,
): WithMachine<NM, LivePagesResult<Item, NoInfer<C>>>;
export function useLive<
  Item,
  Meta,
  Q,
  QIn,
  C extends string = never,
  NM extends MachineFeature | undefined = undefined,
>(
  value: LivePagedValue<Item, Meta, Q, QIn, LiveValueOrigin, C, NM>,
  query: NoInfer<QIn> | null,
  options?: LiveValuePagesOptions,
  // `NoInfer`: `C` is the declaration's — never widened by the result's
  // annotation (`LiveListResult<Item>` would infer `string`).
): WithMachine<NM, LiveListResult<Item, NoInfer<C>>>;
/**
 * - `useLive(queryValue, query)` — a typed-query value
 *   (`liveValue(key, { query })`): the question is the schema's INPUT, encoded
 *   to its one canonical tuple (so an inline literal is fine). `null` reads
 *   nothing (pending), as for a param'd value; a changed question is a new
 *   tuple and shows loading.
 */
export function useLive<
  T,
  Q,
  QIn,
  C extends string = never,
  NM extends MachineFeature | undefined = undefined,
>(
  value: LiveQueryValue<T, Q, QIn, LiveValueOrigin> &
    SnapshotDecl &
    RefusalsDecl<C> &
    MachineDecl<NM>,
  query: NoInfer<QIn> | null,
): WithMachine<NM, LiveSnapshotResult<T, C>>;
export function useLive<
  T,
  Q,
  QIn,
  C extends string = never,
  NM extends MachineFeature | undefined = undefined,
>(
  value: LiveQueryValue<T, Q, QIn, LiveValueOrigin> &
    RefusalsDecl<C> &
    MachineDecl<NM>,
  query: NoInfer<QIn> | null,
): WithMachine<NM, ResourceResult<T, C>>;
/**
 * - A value declared `load: "snapshot"` (plain or typed-query) reads the same
 *   way, and its result adds `refresh()` — see {@link LiveSnapshotResult}.
 */
export function useLive<
  T,
  P extends Record<string, string>,
  C extends string = never,
  NM extends MachineFeature | undefined = undefined,
>(
  value: LivePlainValue<T, P, LiveValueOrigin> &
    SnapshotDecl &
    RefusalsDecl<C> &
    MachineDecl<NM>,
  ...params: LiveValueArgs<NoInfer<P>>
): WithMachine<NM, LiveSnapshotResult<T, C>>;
export function useLive<
  T,
  P extends Record<string, string>,
  C extends string = never,
  NM extends MachineFeature | undefined = undefined,
>(
  value: LivePlainValue<T, P, LiveValueOrigin> &
    RefusalsDecl<C> &
    MachineDecl<NM>,
  // `NoInfer`: `P` is the declaration's — a `{ path } | null` argument must not
  // narrow it past a declared optional param.
  ...params: LiveValueArgs<NoInfer<P>>
): WithMachine<NM, ResourceResult<T, C>>;
export function useLive<Row, F, S extends string>(
  source:
    | null
    | LiveCollection<Row, F, S>
    | LiveRowsCollection<Row>
    | LiveAllCollection<Row>
    | LiveAllCollection<Row, string>
    | LiveValue<unknown, Record<string, string>, LiveValueOrigin>
    // biome-ignore lint/suspicious/noExplicitAny: a generic item's schema is invariant — erased, as page-source's `AnyPagedValue` is.
    | LivePagedPages<any, any, any, LiveValueOrigin>,
  query?:
    | LiveQuery<F, S>
    | LiveGroupQuery<F>
    | LiveCountQuery<F>
    | LiveIdsQuery
    | LiveAllSelect<Row, unknown>
    | LiveScopedAllQuery<string>
    | (LiveScopedAllQuery<string> & LiveAllSelect<Row, unknown>)
    | Record<string, string>
    | readonly unknown[]
    | null,
  options?: LivePagesOptions | LiveValuePagesOptions,
):
  | LiveListResult<unknown>
  | ResourceResult<unknown>
  | readonly ResourceResult<unknown>[]
  | LivePagesResult<unknown>
  | LiveUnavailable {
  // A declaration that needs the computer, under a transport with none behind
  // it, reads nothing: its own kind of read (no subscription, no HTTP read),
  // held like every other — a subtree's transport is fixed, and a
  // declaration's `needsMachine` is.
  const { machine } = useTransport();
  const needsMachine =
    source === null
      ? undefined
      : (source as { needsMachine?: MachineFeature }).needsMachine;
  // Which read this call is. Every branch below calls a different set of
  // hooks, so a call site must ask the same kind on every render: a
  // declaration never changes kind (it is a module-level const), and a call
  // site's overload fixes the rest — a viewport or not, a count or a window,
  // an id set or not. The first render's kind is held, and a later render
  // asking another throws rather than corrupting the hook order.
  const kind =
    needsMachine !== undefined && !machine
      ? "unavailable"
      : readKindOf(source, query, options);
  const [firstKind] = useState(kind);
  if (kind !== firstKind) {
    throw new Error(
      `useLive("${keyOf(source)}"): this call site read a ${READ_KIND[firstKind]}, and now asks a ${READ_KIND[kind]} — a call site reads one kind of thing on every render (a viewport, a count, an id set: always or never)`,
    );
  }
  /* eslint-disable react-hooks/rules-of-hooks -- each branch is fixed per call site: asserted above */
  switch (kind) {
    case "unavailable":
      return useUnavailable(needsMachine!);
    case "viewport-pages":
      // Before `null → count`: a paged read passes a `null` collection to
      // read nothing (a detached or sectioned DataView), keeping its hooks.
      return useViewportPages(
        source as LiveCollection<Row, F, S> | null,
        query as LivePagesQuery<F, S> | null,
        options as LivePagesOptions,
      );
    case "count":
      // `null` source or query: only the count overload takes one.
      return useCount(
        source as LiveCollection<Row, F, S> | null,
        query as LiveCountQuery<F> | null,
      );
    case "value-pages":
      return useValuePages(
        source as unknown as LivePagedValue<
          unknown,
          unknown,
          unknown,
          unknown,
          LiveValueOrigin
        >,
        query as unknown,
        options as LiveValuePagesOptions | undefined,
      );
    case "query-value": {
      const read = useQueryValue(
        source as LiveQueryValue<unknown, unknown, unknown, LiveValueOrigin>,
        query as unknown,
      );
      // A declaration is a snapshot or not for good: the branch is fixed too.
      return isSnapshot(source!) ? useSnapshotRead(read) : read;
    }
    case "value": {
      // `null` is the substrate's skip; `useResource` canonicalizes the params
      // (an absent optional one is one tuple however it is spelled).
      const read = useResource(
        source as LiveValue<unknown, Record<string, string>, LiveValueOrigin>,
        query as Record<string, string> | null | undefined,
      );
      return isSnapshot(source!) ? useSnapshotRead(read) : read;
    }
    case "query-value-list":
      return useQueryValueList(
        source as LiveQueryValue<unknown, unknown, unknown, LiveValueOrigin>,
        query as readonly unknown[],
      );
    case "value-list":
      return useValueList(
        source as LiveValue<unknown, Record<string, string>, LiveValueOrigin>,
        query as readonly (Record<string, string> | null)[],
      );
    case "all":
      return useAll(
        (source as LiveAllCollection<Row, string>).all,
        (query ?? undefined) as AllQuery<Row> | undefined,
      );
    case "all-pages":
      return useAllPages(
        source as LiveCollection<Row, F, S>,
        (query ?? undefined) as LiveQuery<F, S> | undefined,
      );
    case "collection":
      return useCollection(
        source as LiveCollection<Row, F, S> | LiveRowsCollection<Row>,
        query as LiveGroupQuery<F> | LiveIdsQuery,
      );
  }
  /* eslint-enable react-hooks/rules-of-hooks */
}

/** What one `useLive` call reads — each a different set of hooks — in words. */
const READ_KIND = {
  unavailable: "read that needs the computer, under a transport without it",
  "viewport-pages": "paged read kept live by a viewport",
  count: "count",
  "value-pages": "paged value (its pages every one live, no viewport)",
  "query-value": "typed-query value",
  value: "value",
  "query-value-list": "list of typed-query value tuples",
  "value-list": "list of value tuples",
  all: "whole `all` set",
  "all-pages": "window read (its pages every one live, no viewport)",
  collection: "grouping or id set",
} as const;
type ReadKind = keyof typeof READ_KIND;

function readKindOf(
  source: object | null,
  query: object | null | undefined,
  options: object | undefined,
): ReadKind {
  // A viewport first: a paged read's `null` collection is not a count's skip.
  // Read by value, not by key: a value read's `{ limit, viewport: undefined }`
  // (its `viewport?: never`) is a read with none.
  if ((options as { viewport?: unknown } | undefined)?.viewport !== undefined) {
    return "viewport-pages";
  }
  if (source === null) return "count";
  if ("live" in source) {
    const decl = source as unknown as {
      key: string;
      query?: unknown;
      paged?: unknown;
    };
    // A list of tuples (an array is never a single tuple: params are a
    // record, and a question schema may not be a list — the declaration
    // refuses one).
    if (Array.isArray(query)) {
      if (decl.query === undefined) return "value-list";
      if (decl.paged !== undefined) {
        throw new Error(
          `useLive("${decl.key}"): a paged value reads one question — a list of questions is not a paged read.`,
        );
      }
      return "query-value-list";
    }
    if (decl.query === undefined) return "value";
    return decl.paged === undefined ? "query-value" : "value-pages";
  }
  // A collection declared `all` reads its whole set — unless the query is an
  // id set, which goes to `:rows` like any collection's.
  const isIds = query != null && "ids" in query;
  if ((source as { all?: unknown }).all !== undefined && !isIds) return "all";
  // A count — or `null`, which only the count overload takes on a collection.
  if (query === null || (query !== undefined && "count" in query)) {
    return "count";
  }
  // Any other window read: its pages, every one live. A grouping and an id
  // set are one tuple each.
  const isGroups =
    query !== undefined &&
    "groupBy" in query &&
    (query as { groupBy?: unknown }).groupBy !== undefined;
  return isIds || isGroups ? "collection" : "all-pages";
}

/** The read of a declaration that needs the computer, where none is behind the transport. */
function useUnavailable(feature: MachineFeature): LiveUnavailable {
  return useMemo(
    () => ({ status: "unavailable", message: unavailableMessage(feature) }),
    [feature],
  );
}

/** A source's key, for an error message. */
function keyOf(source: object | null): string {
  return source === null ? "null" : String((source as { key?: unknown }).key);
}

/** Whether a value declaration is branded `load: "snapshot"`. */
function isSnapshot(decl: object): boolean {
  return (decl as { snapshot?: true }).snapshot === true;
}

/**
 * A snapshot read: the read plus `refresh()` — its own `refetch`, which for an
 * on-demand descriptor is an HTTP read, and for a snapshot one the server
 * always answers by running the loader. Keeps its identity until the read
 * changes, like every `useLive` result.
 */
function useSnapshotRead<T>(read: ResourceResult<T>): LiveSnapshotResult<T> {
  // A snapshot is measured when its reader mounts. A first mount's read does
  // that (the on-demand HTTP read), but a remount over a read still cached
  // (the query client's `staleTime: Infinity`) would otherwise show the old
  // measure as `ready` without asking — so a mount that finds one cached
  // re-measures it once, keeping the cached read on screen meanwhile.
  const [remeasure] = useState(() =>
    read.status === "loading" ? null : read.refetch,
  );
  useEffect(() => {
    if (remeasure !== null) void remeasure();
  }, [remeasure]);
  return useMemo(() => ({ ...read, refresh: read.refetch }), [read]);
}

/**
 * A typed-query value: the question encoded through the declaration's own
 * codec (the one its params gate and serve half decode with) — memoized on
 * the encoding, so an inline literal names one tuple across renders.
 */
function useQueryValue<T, Q, QIn>(
  value: LiveQueryValue<T, Q, QIn, LiveValueOrigin>,
  query: QIn | null,
): ResourceResult<T> {
  const q = query === null ? null : value.query.encode(query).q;
  const params = useMemo(() => (q === null ? null : { q }), [q]);
  return useResource(value, params);
}

/** A skipped tuple of a list read: loading, nothing read, nothing to refetch. */
const SKIPPED_TUPLE: ResourceResult<never> = {
  status: "loading",
  refetch: () => Promise.resolve(),
};

/** A tuple's identity for dedupe: its canonical params, keys sorted. */
function tupleIdentity(p: Record<string, string>): string {
  return JSON.stringify(
    Object.keys(p)
      .sort()
      .map((k) => [k, p[k]]),
  );
}

/**
 * Many tuples of one value (`useLive(v, [p1, p2, …])`): each non-null entry
 * canonicalized (an absent optional param is one tuple however it is
 * spelled), the distinct tuples read ONCE each through live-state's
 * `useResources` — subscribed by diff, so a tuple kept across a list change is
 * never re-subscribed and keeps its settled state — and the results handed
 * back per entry, in order; a `null` entry is {@link SKIPPED_TUPLE}. A
 * snapshot value's results add `refresh()`, as its single read does. The
 * returned array keeps its identity until an entry's result changes.
 */
function useValueList(
  value: LiveValue<unknown, Record<string, string>, LiveValueOrigin>,
  list: readonly (Record<string, string> | null)[],
): readonly (ResourceResult<unknown> | LiveSnapshotResult<unknown>)[] {
  const listJson = JSON.stringify(
    list.map((p) =>
      p === null ? null : canonicalParams(p, value.optionalParams),
    ),
  );
  const plan = useMemo(() => {
    const entries = JSON.parse(listJson) as (Record<string, string> | null)[];
    const index = new Map<string, number>();
    const distinct: Record<string, string>[] = [];
    const slots = entries.map((p) => {
      if (p === null) return -1;
      const id = tupleIdentity(p);
      let i = index.get(id);
      if (i === undefined) {
        i = distinct.length;
        index.set(id, i);
        distinct.push(p);
      }
      return i;
    });
    return { distinct, slots };
  }, [listJson]);
  const results = useResources(value, plan.distinct);
  const snapshot = isSnapshot(value);
  // One `refresh` wrapper per tuple RESULT: `useResources` keeps an unchanged
  // tuple's result object, so the wrapper is kept with it and a tuple whose
  // read did not move hands back the object it handed back before.
  const [withRefresh] = useState(
    () => new WeakMap<ResourceResult<unknown>, LiveSnapshotResult<unknown>>(),
  );
  return useMemo(() => {
    const reads = results.map(
      (r): ResourceResult<unknown> | LiveSnapshotResult<unknown> => {
        if (!snapshot) return r;
        let read = withRefresh.get(r);
        if (read === undefined) {
          read = { ...r, refresh: r.refetch };
          withRefresh.set(r, read);
        }
        return read;
      },
    );
    return plan.slots.map((i) => (i === -1 ? SKIPPED_TUPLE : reads[i]!));
  }, [plan, results, snapshot, withRefresh]);
}

/**
 * Many questions of one typed-query value (`useLive(v, [q1, q2, …])`): each
 * encoded through the declaration's codec to its one tuple (`null` stays a
 * skip), then read as {@link useValueList} reads a tuple list.
 */
function useQueryValueList<T, Q, QIn>(
  value: LiveQueryValue<T, Q, QIn, LiveValueOrigin>,
  queries: readonly unknown[],
): readonly ResourceResult<unknown>[] {
  const tuples = queries.map((q) =>
    q === null ? null : value.query.encode(q as QIn),
  );
  return useValueList(
    value as unknown as LiveValue<
      unknown,
      Record<string, string>,
      LiveValueOrigin
    >,
    tuples,
  );
}

/**
 * The whole ordered set, straight through `useResource` on its param-less
 * tuple (`{}` — the one boot hydrates), or a scoped set's one scope (its
 * `where` record, the tuple's params): no row map. Always a gated read, so its
 * first value re-renders even when the slice equals what the caller saw
 * before it landed, a push that changes nothing it reads re-renders nothing,
 * and a tuple already cached starts narrowed (the derived latch), so a
 * hydrated read renders once. A plain read hands React Query NO selector
 * (`UseResourceGateOptions`), so its `data` IS the cached array — every
 * observer shares it and its row objects, never a per-observer structurally
 * shared copy. One unconditional call either way (rules of hooks).
 */
function useAll<Row>(
  all: LiveAllCollection<Row, string>["all"],
  query: AllQuery<Row> | undefined,
): ResourceResult<unknown> {
  // A scoped set (`all: { by }`) is read by its scope, the whole set by none:
  // the overloads pair them, this holds the line for an untyped caller (the
  // server would refuse the tuple as a contract mismatch, far from here).
  const scoped = (all.all as { by?: readonly string[] }).by !== undefined;
  const where = query?.where;
  if (scoped && where === undefined) {
    throw new Error(
      `useLive("${all.key}"): the set is declared \`all: { by }\` — read one scope, \`{ where: { ${(all.all.by ?? []).join(", ")} } }\`.`,
    );
  }
  if (!scoped && where !== undefined) {
    throw new Error(
      `useLive("${all.key}"): \`where\` on a set declared without \`all.by\` — it has one tuple, the whole set.`,
    );
  }
  return useResource(all, where, { gate: true, select: query?.select });
}

/** What `useAll` reads: a scope (a scoped set's), a slice, both or neither. */
type AllQuery<Row> = {
  where?: Record<string, string>;
  select?: (rows: Row[]) => unknown;
};

/**
 * A collection's total over `where` through its `:count` sibling — a `null`
 * query (or collection) reads nothing, on {@link SKIPPED_COUNT}: a skipped read
 * never names a resource's params, so a collection with no `:count` may be
 * skipped too.
 */
function useCount<Row, F, S extends string>(
  collection: LiveCollection<Row, F, S> | null,
  query: LiveCountQuery<F> | null,
): ResourceResult<number> {
  const descriptor = collection?.count ?? null;
  if (descriptor === null && query !== null) {
    throw new Error(
      `useLive("${collection?.key ?? "null"}", { count }): the collection is not declared \`count: true\``,
    );
  }
  const paramsKey =
    query === null || descriptor === null
      ? null
      : JSON.stringify(
          descriptor.count.encode({
            where: query.where,
            columns: query.columns,
          }),
        );
  const params = useMemo(
    () =>
      paramsKey === null
        ? null
        : (JSON.parse(paramsKey) as Record<string, string>),
    [paramsKey],
  );
  return useResource(
    (descriptor ?? SKIPPED_COUNT) as ResourceDescriptor<
      number,
      Record<string, string>
    >,
    params,
  );
}

/**
 * The descriptor a skipped count reads (always with `null` params, so never
 * subscribed or fetched): never registered, its key no collection can mint.
 */
const SKIPPED_COUNT: ResourceDescriptor<number, Record<string, string>> = {
  key: "network/live:count:skipped",
  schema: z.number(),
  validateParams: () => {
    throw new Error("network/live: the skipped count is never read");
  },
};

/**
 * A grouping (one tuple whose limit grows) or an explicit id set (the `:rows`
 * point sibling, no paging fields). A window read never comes here: it is
 * read as pages ({@link useAllPages}).
 */
function useCollection<Row, F, S extends string>(
  collection: LiveCollection<Row, F, S> | LiveRowsCollection<Row>,
  query: LiveGroupQuery<F> | LiveIdsQuery,
): LiveListResult<unknown> | ResourceResult<Row[]> {
  const ids = "ids" in query ? query.ids : undefined;
  // An id set reads `:rows` alone — it never touches the groups codec, which a
  // lookup-only collection does not have. A grouping is typed to a full one.
  const shape =
    ids === undefined
      ? groupShape(
          collection as LiveCollection<Row, F, S>,
          query as LiveGroupQuery<F>,
        )
      : null;

  // A grow is forgotten (back to the asked limit) as soon as the query changes.
  const [grown, setGrown] = useState<{
    base: string;
    from: number;
    limit: number;
  } | null>(null);
  const grow = shape !== null && grown?.base === shape.base ? grown : null;
  const limit = grow?.limit ?? shape?.askedLimit ?? 0;

  const idsKey =
    ids === undefined ? null : collection.rows.point.encode(ids).ids;
  const paramsKey = JSON.stringify(
    shape === null ? { ids: idsKey } : shape.encode(limit),
  );
  const prevKey = JSON.stringify(
    grow && shape ? shape.encode(grow.from) : null,
  );
  const params = useMemo(
    () => JSON.parse(paramsKey) as Record<string, string>,
    [paramsKey],
  );

  const descriptor: AnyDescriptor =
    shape === null ? (collection.rows as AnyDescriptor) : shape.descriptor;
  const current = useResource(descriptor, params);

  // The list a grow started from, kept subscribed ONLY while the grown one has
  // no value — loading, or failed before its first (then this collapses onto
  // `params`, a shared refcount, and the old tuple is released).
  const growUnsettled =
    grow !== null &&
    (current.status === "loading" || current.status === "error");
  const prevParams = useMemo(
    () =>
      growUnsettled ? (JSON.parse(prevKey) as Record<string, string>) : params,
    [growUnsettled, prevKey, params],
  );
  const previous = useResource(descriptor, prevParams);

  // The list result keeps its identity (and so does `loadMore`) until what it
  // is built from changes, as `useResource`'s own results do between pushes:
  // consumers memoize on it. Every input below is a primitive or one of those
  // results — never `shape`, which `groupShape` rebuilds on every render.
  const base = shape?.base ?? null;
  const step = shape?.step ?? 0;
  const maxLimit = shape?.maxLimit ?? 0;
  const loadMore = useCallback(() => {
    const next = Math.min(limit + step, maxLimit);
    if (base === null || next === limit) return;
    setGrown({ base, from: limit, limit: next });
  }, [base, limit, step, maxLimit, setGrown]);
  const list = useMemo((): LiveListResult<unknown> => {
    switch (current.status) {
      case "ready": {
        const data = current.data as unknown[];
        return {
          ...current,
          data,
          canGrow: data.length === limit && limit < maxLimit,
          growing: false,
          loadMore,
        };
      }
      case "loading":
        // A grow in flight stays READY on the groups it grew from — those are
        // server-vouched and still subscribed — so the list never flashes a
        // spinner over groups it already rendered.
        if (growUnsettled && previous.status === "ready") {
          return {
            status: "ready",
            data: previous.data as unknown[],
            refetch: previous.refetch,
            canGrow: false,
            growing: true,
            loadMore,
          };
        }
        return current as LiveListResult<unknown>;
      case "error":
        // A grow that failed before its first value: the error, with the
        // list it grew from as `stale` (a surface can keep showing it).
        if (
          growUnsettled &&
          current.stale === undefined &&
          previous.status === "ready"
        ) {
          return {
            status: "error",
            error: current.error,
            stale: previous.data as unknown[],
            refetch: current.refetch,
          };
        }
        return current as LiveListResult<unknown>;
    }
  }, [growUnsettled, previous, current, limit, maxLimit, loadMore]);

  if (shape === null) return current as ResourceResult<Row[]>;
  return list;
}

/**
 * The no-row answer — a `null` id, or one no point set can carry (empty, or
 * holding a `,`): no row is addressable by it, and there is nothing to refetch.
 */
const NO_ID: LiveRowResult<never> = {
  status: "ready",
  found: false,
  refetch: () => Promise.resolve(),
};

/**
 * Read one row of a live collection by id: `loading`, then `ready` with
 * `found: true` and the row, or `found: false` when the server answered and no
 * such row exists — a determinate answer, never a spinner — or `error` when the
 * read failed (with the row as last seen, as `stale`). Reads the `:rows` point
 * sibling, so it ignores every window filter and bound: it answers "does this
 * row exist".
 *
 * A `null` id (nothing to look up yet) is `found: false` from the first render
 * and reads nothing (the substrate's skip — no subscription, not a pending
 * mount): no id names no row. So is an id the point codec cannot carry (`""`,
 * or one holding a `,` — the wire set is comma-joined): no row can be
 * addressed by it, so the answer is as determinate as for `null`. A reader
 * handed an id from outside (a URL, a `[[page:…]]` token, an agent's tool
 * input) therefore renders its not-found state, never a render error.
 */
export function useLiveRow<
  Row,
  NM extends MachineFeature | undefined = undefined,
>(
  collection: LiveRowsCollection<Row> & MachineDecl<NM>,
  id: string | null,
): WithMachine<NM, LiveRowResult<CollectionRow<Row>>>;
export function useLiveRow<Row>(
  collection: LiveRowsCollection<Row> & MachineDecl<MachineFeature | undefined>,
  id: string | null,
): LiveRowResult<CollectionRow<Row>> | LiveUnavailable {
  // A collection that needs the computer, under a transport with none behind
  // it: nothing is read (the same skip as a `null` id), and the read is
  // `unavailable`.
  const { machine } = useTransport();
  const { needsMachine } = collection;
  const unavailable = needsMachine !== undefined && !machine;
  const unavailableRead = useMemo(
    (): LiveUnavailable | null =>
      needsMachine !== undefined && !machine
        ? { status: "unavailable", message: unavailableMessage(needsMachine) }
        : null,
    [needsMachine, machine],
  );
  const absent = unavailable || id === null || !isPointId(id);
  const idsKey = absent ? null : collection.rows.point.encode([id]).ids;
  const params = useMemo(
    () => (idsKey === null ? null : { ids: idsKey }),
    [idsKey],
  );
  const result = useResource(collection.rows, params);
  // The result keeps its identity until what it is built from changes, like
  // `useLive`'s list result: consumers memoize on it. `useResource`'s own
  // result changes only with its status / data / error / stale.
  return useMemo((): LiveRowResult<CollectionRow<Row>> | LiveUnavailable => {
    if (unavailableRead !== null) return unavailableRead;
    // Determinate without the server: no (carriable) id names no row.
    if (absent) return NO_ID;
    const { refetch } = result;
    switch (result.status) {
      case "loading":
        return result;
      case "error": {
        // A one-id tuple's payload is `[row]` or `[]` — its stale one included.
        // Rows of a collection: the read's own (`CollectionRow`, type-only).
        const stale = result.stale?.[0] as CollectionRow<Row> | undefined;
        return stale === undefined
          ? { status: "error", error: result.error, refetch }
          : {
              status: "error",
              error: result.error,
              stale,
              refetch,
            };
      }
      case "ready": {
        const row = result.data[0] as CollectionRow<Row> | undefined;
        return row === undefined
          ? { status: "ready", found: false, refetch }
          : { status: "ready", found: true, row, refetch };
      }
    }
  }, [unavailableRead, absent, result]);
}
