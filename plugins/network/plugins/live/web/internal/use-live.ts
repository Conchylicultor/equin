import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { canonicalParams } from "@plugins/network/plugins/live/plugins/canonical-params/core";
import {
  useResource,
  useResources,
  type PagedResourceResult,
  type ResourceDescriptor,
  type ResourceError,
  type ResourceResult,
  type ResourceUnavailable,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import type {
  LiveAllCollection,
  LiveCollection,
  LiveCountQuery,
  LiveGroup,
  LiveGroupableColumn,
  LiveGroupQuery,
  LiveGroupValue,
  LiveIdsQuery,
  LiveOrderBy,
  LiveQuery,
  LiveRowQuery,
  LiveScopedAllQuery,
  LivePagedPages,
  LivePagedValue,
  LivePlainValue,
  LiveQueryValue,
  LiveRowsCollection,
  LiveTree,
  LiveTreeCollection,
  LiveValue,
  LiveValueOrigin,
  LiveWhereOf,
} from "@plugins/network/plugins/live/core";
import {
  COLLECTION_KIND_KEYS,
  isPointId,
  type CollectionKindKey,
  type CollectionRow,
} from "@plugins/network/plugins/live/core";
import { useTransport } from "@plugins/primitives/plugins/networking/web";
import {
  unavailableMessage,
  type MachineFeature,
} from "@plugins/infra/plugins/endpoints/core";
import {
  useAllPages,
  useTreeAllPages,
  useTreeViewportPages,
  useValuePages,
  useViewportPages,
  type LivePagesOptions,
  type LivePagesResult,
  type LiveValuePagesOptions,
  type WithAncestors,
} from "./use-pages";
import { useRowAncestors } from "./use-ancestors";
import type { LivePagesQuery } from "./page-source";
import { useClockPin } from "./use-clock";

// The read half of a `liveCollection`. A consumer asks a QUERY — a window
// (`where` / `orderBy` / `limit`), a grouping (`groupBy`), a count, an
// explicit id set (`ids`) or one row (`id`) — and never picks the wire
// resource or its params: the window goes to `key`, a grouping to `:groups`,
// an id set and a row to the `:rows` point sibling, and the encoding is the
// declaration's own codec. A window is read as key-range pages; a grouping
// shares the window's list result, grown by its limit; a row read answers
// `LiveRowResult` (found / not found). Every collection query goes through
// ONE signature, so a wrong option errors on its own property. A `liveValue`
// is read by the same hook: its result is `ResourceResult<T>`, the states
// every read already has. There is no second read hook (`live:read-hooks`).

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
export interface RefusalsDecl<C extends string> {
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
export type LiveUnavailable = ResourceUnavailable;

/**
 * A declaration's `needsMachine`, as the parameter side of an overload infers
 * it: `MachineFeature` for a declaration that needs the computer, `undefined`
 * (or nothing to infer from — the default) for a portable one.
 */
export interface MachineDecl<M> {
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

/**
 * How a list read (`useLive(value, [p1, p2, …])`) lets go of a tuple dropped
 * from its list while it stays mounted. `release: "now"`: unsubscribed at
 * once, its cached value dropped, instead of after the keep-alive window —
 * for a reader that drops a tuple on purpose (a DataView row read whose row
 * left the screen, `FieldDef.rowRead`), so what stays subscribed is what the
 * list holds NOW, never every tuple it held in the last keep-alive window.
 * Unmounting still releases through the keep-alive. Default: the keep-alive.
 */
export interface LiveValueListOptions {
  release?: "now";
}

/** The refusal codes a declaration declares (`never`: none). */
type RefusalOf<V> = V extends { refusals?: readonly (infer C extends string)[] }
  ? string extends C
    ? never
    : C
  : never;

/**
 * One tuple's read in a list read of the plain value `V`
 * (`useLive(v, [p…])[i]`), typed by the declaration as that read types it —
 * its refusal codes, a snapshot's `refresh()`, and the unavailable arm of a
 * value that needs the computer (under a transport without it the whole list
 * is that one result). For a host that reads a value on a caller's behalf and
 * hands each tuple's read back (data-view's `rowRead`).
 */
export type LiveValueTupleRead<V> =
  V extends LivePlainValue<infer T, Record<string, string>, LiveValueOrigin>
    ? WithMachine<MachineOf<V>, LiveValueRead<V, T, RefusalOf<V>>>
    : never;

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
 * One row by id (`useLive(c, { id })`): loading, failed, found, or
 * determinately absent — `ready` splits on `found`.
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

/**
 * The facets a collection declares, read off argument 0 structurally: its
 * filterable columns (`F`), sortable ones (`S`) and, declared `all: { by }`,
 * its scope fields (`B`). A facet the collection does not declare stays at
 * its default (`never`).
 */
interface CollectionFacets<Row, F, S extends string, B extends string> {
  filterable?: F;
  sortable?: readonly S[];
  all?: LiveAllCollection<Row, B>["all"] | undefined;
}

/**
 * The row fields outside `by`, each `never` beside a scope record: a scope
 * built before the call (no excess-property check on it) naming one fails.
 */
type NotScopeFields<Row, B extends string> = {
  readonly [K in Exclude<keyof Row & string, B>]?: never;
};

/**
 * A scoped set's skip (`{ where: null }`): its scope is not known yet (another
 * read is still loading it) — `pending`, nothing read. `never` elsewhere.
 */
type ScopeSkip<D> = D extends { window: object }
  ? never
  : [LiveWhereOf<D>] extends [never]
    ? never
    : null;

/** A scoped set's scope record. */
type ScopeWhere<Row, B extends string> = {
  readonly [K in B]: string;
} & NotScopeFields<Row, B>;

/** Every kind key but `K`, refused (`?: never`): a form names one read. */
type OnlyKind<K extends CollectionKindKey | "none"> = {
  readonly [P in Exclude<CollectionKindKey, K>]?: never;
};

/**
 * Where the kind keys' values are inferred — one type parameter each (`not
 * given` = `undefined`). The rest of the query's values are never captured,
 * so tsc's own checks (excess property, value types, `or()`'s columns) run
 * against the forms. Intersected with them: a kind key a form refuses is
 * `never & V` there, an error on that key.
 */
interface KindKeyValues<Row, I, Ids, C, G, R, In = undefined> {
  /** Not a kind key: an option of a tree's window and row reads (`IncludeFor`). */
  readonly include?: In;
  readonly id?: I;
  readonly ids?: Ids;
  readonly count?: C;
  readonly groupBy?: G;
  // The selector itself (its presence never depends on what it returns);
  // the bare signature beside it types an inline lambda's rows before `R`
  // is inferred.
  readonly select?: R | ((rows: CollectionRow<Row>[]) => unknown);
}

/**
 * Whether a kind key's inferred value names its read: `undefined` (not given,
 * or given as nothing — the runtime reads kind keys by value) does not. Not
 * distributive, so for a generic value the conditional is deferred and tsc
 * relates a query to both of its arms ({@link KindGuard}).
 */
type Names<X> = { v: X } extends { v: undefined } ? false : true;

/**
 * The read a query names: the first of {@link COLLECTION_KIND_KEYS} whose
 * inferred value is not `undefined` (the parameters' "not given"; a key
 * holding `undefined` is absent, as the runtime reads it), else `"none"`.
 */
type KindOf<
  P,
  K extends readonly unknown[] = typeof COLLECTION_KIND_KEYS,
> = K extends readonly [infer H extends keyof P, ...infer T]
  ? KindStep<P[H], H, KindOf<P, T>>
  : "none";

/**
 * One step of {@link KindOf}, distributive over the value `V`: for a generic
 * value (a caller's `groupBy: G`) the step is deferred, and a deferred
 * distributive conditional reads as its instantiation at `V`'s constraint —
 * so a generic grouping's result is a grouping, not "a list or a grouping".
 */
type KindStep<V, H, Rest> = V extends undefined ? Rest : H;

/** The inferred kind-key values, by key. */
interface KindValues<I, Ids, C, G, R> {
  id: I;
  ids: Ids;
  count: C;
  groupBy: G;
  select: R;
}

/**
 * The key of the read a query names ({@link KindOf}) is required, on EVERY
 * branch of it: a union whose branches read different things (`cond ? { id }
 * : { where }`) — the call site's kind latch would throw — fails on the
 * branch missing the key.
 *
 * The required type is `{} | null`: holding a unit type, the key is a
 * discriminant, so every form that refuses it (`?: never`) reduces to
 * `never` — a named read leaves ONE form, and tsc reports a misuse on its
 * property (`limit` beside `id`, a second kind key). A conditional per step,
 * like {@link KindOf}: a generic value (deferred) is checked against both
 * arms.
 */
type KindGuard<
  P,
  K extends readonly unknown[] = typeof COLLECTION_KIND_KEYS,
> = K extends readonly [infer H extends keyof P & string, ...infer T]
  ? Names<P[H]> extends true
    ? { readonly [Q in H]: {} | null }
    : KindGuard<P, T>
  : unknown;

/**
 * `include: "ancestors"` — a tree collection's window and row reads add its
 * rows' ancestors (`ancestors` on the ready arm); on any other collection,
 * and beside any other read, `include` is a tsc error.
 */
type IncludeFor<D> = D extends { tree: LiveTree }
  ? { readonly include?: "ancestors" }
  : NoInclude;

/** A form that takes no `include`. */
interface NoInclude {
  readonly include?: never;
}

/** A read's result with its `include` (`In`): its ancestors beside its rows. */
type Included<Res, In, Row> = [In] extends ["ancestors"]
  ? WithAncestors<Res, CollectionRow<Row>>
  : Res;

/** Every key some form of `Forms` names. */
type FormKeys<Forms> = Forms extends unknown ? keyof Forms : never;

/**
 * Every key some collection query form names — computed once, not per call
 * (a key one form names but this collection's do not is refused by its forms
 * themselves: `?: never`).
 */
type QueryKeyName = FormKeys<
  | CollectionForms<
      { window: object; count: object; tree: LiveTree },
      object,
      never,
      never,
      never,
      never
    >
  | CollectionForms<{ all: object }, object, never, never, "scope", never>
>;

/**
 * A key no form names is refused even on a query built before the call,
 * which tsc never excess-checks: `K` is inferred as the query's own keys
 * (keys only — no value is captured), and each key outside `Known` is `never`
 * here. `where`'s slot is the collection's own where type (`W`), so the
 * contextual type `or()` infers its columns from stays exactly that — a
 * slot typed `unknown` there loses them (measured). A `where` built before
 * the call is the lint `live/where-declared`'s: declared with
 * `LiveWhereOf<typeof c>`, it is checked where it is written.
 */
type KnownKeysOnly<K extends PropertyKey, Known, W> = {
  readonly [P in K]?: P extends "where" ? W : P extends Known ? unknown : never;
};

/**
 * The query forms a collection declared `D` takes — a plain union, each
 * naming its own kind key and refusing the others (`?: never`): tsc's own
 * discriminated excess-property and value checks run on it, and every
 * window form's `where` is the collection's own `LiveWhere<F>` (`or()`'s
 * contextual columns). `S` is `NoInfer` in the window form: inferred from
 * the collection alone, so an `orderBy` naming a non-sortable column is
 * refused rather than widening `S`. A new query form is a member here, a
 * key in {@link COLLECTION_KIND_KEYS} and {@link KindKeyValues}, a signature
 * parameter and a {@link CollectionReads} row — never a signature or a hook.
 */
type CollectionForms<D, Row, F, S extends string, B extends string, G> =
  | (LiveRowQuery & OnlyKind<"id"> & IncludeFor<D>)
  | (LiveIdsQuery & OnlyKind<"ids"> & NoInclude)
  | (D extends { window: object }
      ? | (LiveQuery<F, NoInfer<S>> & OnlyKind<"none"> & IncludeFor<D>)
        | (LiveGroupQuery<F, G & LiveGroupableColumn<F>> & OnlyKind<"groupBy">)
        | (D extends { count: object }
            ? LiveCountQuery<F> & OnlyKind<"count">
            : never)
      : D extends { all: object }
        ? // `select` is open on the scope form: a selector is inferred in
          // tsc's second pass, after the kind was first read as none.
          [B] extends [never]
          ? OnlyKind<"select"> & { select: unknown }
          : OnlyKind<"select"> & {
              where: ScopeWhere<Row, B> | null;
              select?: unknown;
            }
        : never);

/**
 * Beside the query object: `undefined` (a window's default query) and `null`
 * (a count's skip — reads nothing, pending — on a counted collection). `N` is
 * inferred from the query through `N & undefined` / `N & null`: the hole
 * exactly when the query may be one, else `never` — so a query that cannot be
 * is checked against its forms alone (tsc elaborates a misuse into no union
 * with `undefined` or `null`).
 */
type QueryHoles<D, N> =
  | (D extends { window: object } ? N & undefined : never)
  | (D extends { window: object; count: object } ? N & null : never);

/** Whether the query may be `null` — a count's skip. */
type MayBeNull<N> = [N] extends [never] ? false : null extends N ? true : false;

/** The count's kind value: a query that may be `null` names a count (its skip reads one). */
type CountValue<C, N> = MayBeNull<N> extends true ? true : C;

/**
 * Beside a `null` skip the query object is a count — whatever else it names
 * (`cond ? { ids } : null` would read an id set, then a count).
 */
type SkipGuard<N> =
  MayBeNull<N> extends true ? { readonly count: true } : unknown;

/**
 * The inferred kind-key values of a query on a collection declared `D`. A
 * selector names its read only on an `all` set — the one that takes it —
 * so on any other collection the misfit is the window form's, on `select`.
 */
type QueryKindValues<D, I, Ids, C, G, R, N> = KindValues<
  I,
  Ids,
  CountValue<C, N>,
  G,
  D extends { all: object } ? R : undefined
>;

/** What a collection read returns, by the read its query names. */
interface CollectionReads<D, Row, G, R> {
  id: LiveRowResult<CollectionRow<Row>>;
  ids: ResourceResult<CollectionRow<Row>[]>;
  count: ResourceResult<number>;
  groupBy: LiveListResult<LiveGroup<LiveGroupValue<Row, G & string>>>;
  select: ResourceResult<R extends (rows: never) => infer T ? T : never>;
  none: D extends { all: object }
    ? ResourceResult<CollectionRow<Row>[]>
    : LiveListResult<CollectionRow<Row>>;
}

/**
 * The count read of a collection that may be `null` — today's `(query)` when
 * argument 0 (`V`) may be `null` and is otherwise a counted window, else an
 * impossible arity (see {@link ValueArgs}). A bare `null` (no collection at
 * all) takes a `null` query or a bare `{ count: true }` (`cond ? { count:
 * true } : null`, both reading nothing): there is no collection whose columns
 * a `where` could name (`Exclude<null, null>` is `never`, which every
 * structural test would pass).
 */
type NullableCountArgs<V> = null extends V
  ? [Exclude<V, null>] extends [never]
    ? [query: { readonly count: true } | null]
    : Exclude<V, null> extends { window: object; count: object }
      ? [query: LiveCountQuery<FilterableOf<V>> | null]
      : [never, never, never]
  : [never, never, never];

/** The filterable columns of a (possibly `null`) collection. */
type FilterableOf<V> =
  Exclude<V, null> extends { filterable: infer F } ? F : never;

/** The `needsMachine` of a (possibly `null`) declaration. */
type MachineOf<V> =
  Exclude<V, null> extends MachineDecl<infer M> ? M : undefined;

/**
 * Arguments 1.. of a value overload, as a REST: an impossible arity when
 * argument 0 (`V`) is a collection (it has `rows`), else today's params.
 * Tested on `rows`, not on a value's own `live`: tsc infers `V` from what is
 * LEFT of argument 0 once the constituents identical to the overload's own
 * are matched away — for a value that strips `live`, for a collection
 * nothing (measured). A
 * collection call therefore leaves every value overload in tsc's ARITY
 * bucket, and the one collection signature is the only candidate its
 * arguments are checked against — a misuse is reported on its own property,
 * never as "No overload matches this call" against the last value overload.
 */
type ValueArgs<V, Args extends unknown[]> = [
  Extract<V, { rows: unknown }>,
] extends [never]
  ? Args
  : [never, never, never];

/**
 * {@link ValueArgs} for a PAGED value's overloads, decided by its question
 * type: argument 0 must stay a bare `LivePagedValue<…>` (no `& V`), or tsc no
 * longer infers its type arguments from the alias — a `needsMachine` paged
 * value's `NM`, a meta-less one's `Meta` (measured) — so the collection test
 * reads `QIn` instead: a paged value always declares a `query` schema (its
 * input is `QIn`), while a collection — or `null` — infers none (`unknown`).
 */
type PagedArgs<QIn, Args extends unknown[]> = unknown extends QIn
  ? [never, never, never]
  : Args;

/**
 * The one 2-argument COLLECTION read, first among the 2-argument signatures:
 * an argument like `where: or(...)` is a generic call TypeScript checks once,
 * against the first arity-matching overload's contextual type — so the
 * query's `where` is literally the collection's own `LiveWhere<F>`.
 *
 * The query is never captured whole: one type parameter per kind key (`I`,
 * `Ids`, `C`, `G`, `R` — {@link KindKeyValues}), the query's `null` /
 * `undefined` (`N` — {@link QueryHoles}) and its key set (`K` —
 * {@link KnownKeysOnly}). The read is the first kind key named, in
 * {@link COLLECTION_KIND_KEYS} order — the runtime dispatch's own list.
 *
 * - `useLive(c, { where, orderBy, limit })` — a window (see `useLive(c)`).
 * - `useLive(c, { groupBy, where?, limit? })` — the values a text / number /
 *   boolean filterable column takes (with counts), ordered by count desc then
 *   value; each value typed as the row field. The same list result as a
 *   window, but one tuple whose limit grows: `loadMore()` reloads the
 *   grouping at one more page of groups, and while the grown one loads the
 *   hook stays settled on the previous groups (`growing: true`).
 * - `useLive(c, { count: true, where? })` — how many rows match `where`, as
 *   `ResourceResult<number>`, kept live; only on a collection declared
 *   `count: true`. `null` in place of the query reads nothing (pending,
 *   typed as the count); `null` in place of the collection is the counted
 *   overload below.
 * - `useLive(c, { ids })` — an explicit id set, via the `:rows` point sibling.
 *   No paging fields: an id set is not a window.
 * - `useLive(c, { id })` — one row by id, via the same sibling:
 *   `LiveRowResult` — `loading`, then `ready` with `found: true` and the row,
 *   or `found: false` when the server answered and no such row exists (a
 *   determinate answer, never a spinner), or `error` with the row as last
 *   seen as `stale`. A `null` id, or one no point set can carry (`""`, one
 *   holding a `,`), is `found: false` from the first render and reads
 *   nothing — an id from a URL, a token or a tool input renders not-found,
 *   never a render error (`{ ids }` throws on one: a set is the caller's to
 *   build).
 * - `useLive(all, { select })`, `useLive(scoped, { where[, select] })` — see
 *   `useLive(all)`.
 *
 * `{ id }` and `{ ids }` take every collection (window, lookup-only, `all`);
 * a list read of a lookup-only collection — it declares no order to list in —
 * is a tsc error. A misuse (an unknown key, a key the read or the collection
 * does not take, a wrong `id`, `count` on an uncounted collection) is
 * reported on its own property; a union naming two reads, and a query built
 * before the call, on the argument.
 */
export function useLive<
  Row,
  D extends object,
  F = never,
  S extends string = never,
  B extends string = never,
  I extends string | null | undefined = undefined,
  Ids extends readonly string[] | undefined = undefined,
  C extends boolean | undefined = undefined,
  G extends string | undefined = undefined,
  R extends ((rows: CollectionRow<Row>[]) => unknown) | undefined = undefined,
  N = never,
  K extends PropertyKey = never,
  NM extends MachineFeature | undefined = undefined,
  In extends "ancestors" | undefined = undefined,
>(
  collection: D &
    LiveRowsCollection<Row> &
    CollectionFacets<Row, F, S, B> &
    MachineDecl<NM>,
  query:
    | (CollectionForms<D, Row, F, S, B, G> &
        KindKeyValues<Row, I, Ids, C, G, R, In> &
        KindGuard<QueryKindValues<D, I, Ids, C, G, R, N>> &
        SkipGuard<N> &
        KnownKeysOnly<K, QueryKeyName, LiveWhereOf<D> | ScopeSkip<D>>)
    | QueryHoles<D, N>,
): WithMachine<
  NM,
  Included<
    CollectionReads<D, Row, G, R>[KindOf<
      QueryKindValues<D, I, Ids, C, G, R, N>
    >],
    In,
    Row
  >
>;
/**
 * - `useLive(c)` — a bounded window at the collection's default query,
 *   read as key-range pages, every one live (page 0 is this window tuple —
 *   the one boot hydrates). Its settled arm adds `canGrow` / `growing` /
 *   `loadMore()`: `loadMore()` splits the last page (one new page, seeded —
 *   never a reload of a larger window), and it never pages past `maxLimit`
 *   rows. While a new page loads the hook STAYS settled on the rows it has
 *   (`growing: true`), so `if (pending)` never flashes a spinner over a list
 *   that already rendered. Under a viewport, see below.
 */
export function useLive<
  Row,
  F,
  S extends string,
  NM extends MachineFeature | undefined = undefined,
>(
  collection: LiveCollection<Row, F, S> & MachineDecl<NM>,
): WithMachine<NM, LiveListResult<CollectionRow<Row>>>;
/**
 * - `useLive(counted | null, { count: true, where? } | null)` — a count whose
 *   collection may be absent: `null` in place of the collection (or of the
 *   query) reads nothing (pending) — for a surface whose count is not cheap
 *   right now (a search is on), or that has no collection to count. Taken
 *   only when argument 0 may be `null` (`NullableCountArgs`), so a call on a
 *   collection never lists it beside the collection signature.
 */
export function useLive<V>(
  collection: V,
  ...args: NullableCountArgs<V>
): WithMachine<MachineOf<V>, ResourceResult<number>>;
/**
 * - `useLive(c, query, { viewport, resetKey? })` — a collection's window read
 *   with no depth limit, its key-range pages kept live by the rows a surface
 *   has on screen (`viewport`, a branded `VisibleRange` only data-view mints):
 *   `LivePagesResult<Row>`, with per-page errors and the placeholders past the
 *   stale budget. `query` has no `limit` (the pages own the limits); `null`
 *   for both reads nothing (loading) with the hook order kept.
 *
 *   Without a viewport, `useLive(c, query?)` is the window read above, read
 *   as the same pages, every one live: `loadMore()` splits the last page, and
 *   never pages past `maxLimit` rows.
 *
 *   On a tree collection, `include: "ancestors"` adds `ancestors` to the ready
 *   arm (one `:ancestors` read per loaded page) — the collection is then never
 *   `null` (a `null` query reads nothing).
 */
export function useLive<
  Row,
  F,
  S extends string,
  NM extends MachineFeature | undefined = undefined,
  D extends object = object,
  In extends "ancestors" | undefined = undefined,
>(
  collection: (LiveCollection<Row, F, S> & MachineDecl<NM> & D) | null,
  query:
    (LivePagesQuery<F, S> & IncludeFor<D> & { readonly include?: In }) | null,
  options: LivePagesOptions,
): WithMachine<NM, Included<LivePagesResult<CollectionRow<Row>>, In, Row>>; /**
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
 * - `useLive(scoped, { where: { pageId } })` — a collection declared
 *   `all: { by }`: every row OF ONE SCOPE, in the declared order (the
 *   `where` record is its tuple: exactly the `by` fields — `LiveScopedAllQuery`);
 *   with `select`, a slice of it. Read and gated exactly like the whole set;
 *   a scope change is a new tuple (loading). `{ where: null }` is its skip —
 *   a scope another read is still loading: `pending`, nothing read (the
 *   `{ id: null }` of a set). `useLive(scoped)` without one is
 *   a tsc error, and a `where` on a set without `by` too (both throw for an
 *   untyped caller).
 *
 * An id read of an `all` collection is `useLive(all, { ids })` /
 * `useLive(all, { id })`, through its `:rows` point sibling like any other —
 * global, whatever the scope. The 2-argument forms are the collection
 * signature's (first).
 */
export function useLive<Row, NM extends MachineFeature | undefined = undefined>(
  collection: LiveAllCollection<Row> & MachineDecl<NM>,
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
 *
 * Every value overload takes its arguments after argument 0 through
 * `ValueArgs` (a rest that is an impossible arity for a collection), so a
 * collection call never lists them as candidates.
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
  V extends object | null = object,
  NM extends MachineFeature | undefined = undefined,
>(
  value: LiveQueryValue<T, Q, QIn, LiveValueOrigin> &
    RefusalsDecl<C> &
    MachineDecl<NM> &
    V,
  ...args: ValueArgs<
    V,
    [queries: LiveQueryList<NoInfer<QIn>>, options?: LiveValueListOptions]
  >
): WithMachine<NM, readonly LiveValueRead<V, T, C>[]>;
export function useLive<
  T,
  P extends Record<string, string>,
  C extends string = never,
  V extends object | null = object,
  NM extends MachineFeature | undefined = undefined,
>(
  value: LivePlainValue<T, P, LiveValueOrigin> &
    RefusalsDecl<C> &
    MachineDecl<NM> &
    V,
  ...args: ValueArgs<
    V,
    [params: LiveValueParamsList<NoInfer<P>>, options?: LiveValueListOptions]
  >
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
  ...args: PagedArgs<
    QIn,
    [query: NoInfer<QIn> | null, options: LivePagesOptions]
  >
): WithMachine<NM, LivePagesResult<Item, NoInfer<C>>>;
// The same read for a GENERIC caller (data-view's `useLivePagedValuePaging`
// passes its own `Item`…`NM`): there `PagedArgs<QIn>` is deferred and admits
// no arguments, so this twin routes on argument 0 itself (`V`, defaulted
// when the type arguments are explicit). A concrete paged value resolves on
// the one above — whose argument 0 must stay the bare alias for its type
// arguments to be inferred — and a collection leaves both by arity.
export function useLive<
  Item,
  Meta,
  Q,
  QIn,
  C extends string = never,
  NM extends MachineFeature | undefined = undefined,
  V extends object = object,
>(
  value:
    (LivePagedValue<Item, Meta, Q, QIn, LiveValueOrigin, C, NM> & V) | null,
  ...args: ValueArgs<V, [query: NoInfer<QIn> | null, options: LivePagesOptions]>
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
  ...args: PagedArgs<
    QIn,
    [query: NoInfer<QIn> | null, options?: LiveValuePagesOptions]
  >
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
  V extends object | null = object,
>(
  value: LiveQueryValue<T, Q, QIn, LiveValueOrigin> &
    SnapshotDecl &
    RefusalsDecl<C> &
    MachineDecl<NM> &
    V,
  ...args: ValueArgs<V, [query: NoInfer<QIn> | null]>
): WithMachine<NM, LiveSnapshotResult<T, C>>;
export function useLive<
  T,
  Q,
  QIn,
  C extends string = never,
  NM extends MachineFeature | undefined = undefined,
  V extends object | null = object,
>(
  value: LiveQueryValue<T, Q, QIn, LiveValueOrigin> &
    RefusalsDecl<C> &
    MachineDecl<NM> &
    V,
  ...args: ValueArgs<V, [query: NoInfer<QIn> | null]>
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
    | LiveRowQuery
    | LiveAllSelect<Row, unknown>
    | LiveScopedAllQuery<string>
    | (LiveScopedAllQuery<string> & LiveAllSelect<Row, unknown>)
    | Record<string, string>
    | readonly unknown[]
    | null,
  options?: LivePagesOptions | LiveValuePagesOptions | LiveValueListOptions,
  // A value overload's `ValueArgs` never-arm (an impossible arity) — never passed.
  ..._unreachable: never[]
):
  | LiveListResult<unknown>
  | ResourceResult<unknown>
  | readonly ResourceResult<unknown>[]
  | LivePagesResult<unknown>
  | LiveRowResult<unknown>
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
        usePinnedClock(source, query as LivePagesQuery<F, S> | null),
        options as LivePagesOptions,
      );
    case "count":
      // `null` source or query: only the count overload takes one.
      return useCount(
        source as LiveCollection<Row, F, S> | null,
        usePinnedClock(source, query as LiveCountQuery<F> | null),
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
        options as LiveValueListOptions | undefined,
      );
    case "value-list":
      return useValueList(
        source as LiveValue<unknown, Record<string, string>, LiveValueOrigin>,
        query as readonly (Record<string, string> | null)[],
        options as LiveValueListOptions | undefined,
      );
    case "all":
      return useAll(
        (source as LiveAllCollection<Row, string>).all,
        (query ?? undefined) as AllQuery<Row> | undefined,
      );
    case "all-pages":
      return useAllPages(
        source as LiveCollection<Row, F, S>,
        usePinnedClock(source, query as LiveQuery<F, S> | null | undefined) ??
          undefined,
      );
    case "row":
      return useRow(
        source as LiveRowsCollection<Row>,
        (query as LiveRowQuery).id,
      );
    case "viewport-pages-ancestors":
      return useTreeViewportPages(
        source as LiveTreeCollection<Row, F, S>,
        usePinnedClock(
          source,
          withoutInclude(query as LivePagesQuery<F, S> | null),
        ),
        options as LivePagesOptions,
      );
    case "all-pages-ancestors":
      return useTreeAllPages(
        source as LiveTreeCollection<Row, F, S>,
        usePinnedClock(
          source,
          withoutInclude(query as LiveQuery<F, S> | null | undefined),
        ) ?? undefined,
      );
    case "row-ancestors":
      return useTreeRow(
        source as LiveTreeCollection<Row, unknown, string>,
        (query as LiveRowQuery).id,
      );
    case "collection":
      return useCollection(
        source as LiveCollection<Row, F, S> | LiveRowsCollection<Row>,
        usePinnedClock(source, query as LiveGroupQuery<F> | LiveIdsQuery),
      );
  }
  /* eslint-enable react-hooks/rules-of-hooks */
}

/**
 * The query with the reader's pinned clock filled in — exactly when its
 * `where` / `orderBy` names a clock field of the collection (`clockField`):
 * `now` floored to the field's quantum, re-pinned at the next boundary (a new
 * tuple: the window reloads). Any other query, an id set, a paged value's
 * question or a `null` passes through untouched, and arms no timer.
 */
function usePinnedClock<Q extends object | null | undefined>(
  source: object | null,
  query: Q,
): Q {
  const codec =
    source !== null &&
    "window" in source &&
    typeof (source as { window?: { window?: unknown } }).window?.window ===
      "object"
      ? (source as LiveCollection<unknown, unknown, string>).window.window
      : null;
  const named =
    query === null || query === undefined || "ids" in query ? null : query;
  const quantum =
    codec === null || named === null
      ? null
      : codec.clockQuantum(
          named as { where?: object; orderBy?: LiveOrderBy<string> },
        );
  const now = useClockPin(quantum);
  return useMemo(
    () => (now === null || named === null ? query : { ...named, now }) as Q,
    [query, named, now],
  );
}

/**
 * The query without `include` — what the window's codec and pages read, so a
 * tree read's tuples are byte-identical to the plain read's (the boot-hydrated
 * default page included). Memoized by the caller's `usePinnedClock`.
 */
function withoutInclude<Q extends object | null | undefined>(query: Q): Q {
  if (query === null || query === undefined || !("include" in query)) {
    return query;
  }
  const { include: _include, ...rest } = query as Q & { include?: unknown };
  return rest as Q;
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
  row: "row by id",
  collection: "grouping or id set",
  "viewport-pages-ancestors":
    "tree read with its ancestors, kept live by a viewport",
  "all-pages-ancestors": "tree window read with its ancestors",
  "row-ancestors": "tree row by id with its ancestors",
} as const;
type ReadKind = keyof typeof READ_KIND;

function readKindOf(
  source: object | null,
  query: object | null | undefined,
  options: object | undefined,
): ReadKind {
  const kind = plainReadKindOf(source, query, options);
  const include =
    query == null ? undefined : (query as { include?: unknown }).include;
  if (include === undefined) return kind;
  const key = keyOf(source);
  if (include !== "ancestors") {
    throw new Error(
      `useLive("${key}"): \`include\` is "ancestors" or absent, got ${JSON.stringify(include)}.`,
    );
  }
  if (((source as { tree?: unknown } | null)?.tree ?? null) === null) {
    throw new Error(
      `useLive("${key}"): \`include: "ancestors"\` reads a tree collection's ancestors — this one is not declared \`tree\`.`,
    );
  }
  switch (kind) {
    case "viewport-pages":
      return "viewport-pages-ancestors";
    case "all-pages":
      return "all-pages-ancestors";
    case "row":
      return "row-ancestors";
    case "unavailable":
    case "count":
    case "value-pages":
    case "query-value":
    case "value":
    case "query-value-list":
    case "value-list":
    case "all":
    case "collection":
    case "viewport-pages-ancestors":
    case "all-pages-ancestors":
    case "row-ancestors":
      throw new Error(
        `useLive("${key}"): \`include: "ancestors"\` goes with a window or a row read — not with a ${READ_KIND[kind]}.`,
      );
  }
}

function plainReadKindOf(
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
  // A collection: the query's kind key decides — at most one, read by value
  // (`{ id: undefined, where }` type-checks with no
  // `exactOptionalPropertyTypes` and is a window read; a `null` id is an id).
  // Two kind keys holding values would read one and drop the other, so an
  // untyped caller's is a throw.
  const kindKeys =
    query == null
      ? []
      : COLLECTION_KIND_KEYS.filter(
          (k) =>
            (query as Partial<Record<CollectionKindKey, unknown>>)[k] !==
            undefined,
        );
  if (kindKeys.length > 1) {
    throw new Error(
      `useLive("${keyOf(source)}"): a query reads one thing — this one names ${kindKeys.map((k) => `\`${k}\``).join(" and ")} (one row, an id set, a count, a grouping and a slice are each their own read).`,
    );
  }
  const kindKey = kindKeys[0];
  const isAll = (source as { all?: unknown }).all !== undefined;
  switch (kindKey) {
    case "id":
      return "row";
    case "ids":
      return "collection";
    case "select":
      // A slice is an `all` set's (tsc refuses one elsewhere): beside a window
      // no read would apply it.
      if (!isAll) {
        throw new Error(
          `useLive("${keyOf(source)}"): \`select\` slices a collection declared \`all\` — this one is not (a window, a grouping and a count take no \`select\`).`,
        );
      }
      return "all";
    case "count":
      return "count";
    case "groupBy":
      return "collection";
    case undefined:
      break;
  }
  // `null` only the count signature takes on a collection: its skip.
  if (query === null) return "count";
  // An `all` set reads its whole set (or its scope); any other window read
  // its pages, every one live.
  return isAll ? "all" : "all-pages";
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

/** `useResources`' options for a list read's `release`. */
const RELEASE_NOW = { release: "now" } as const;
const KEEP_ALIVE = {};

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
 * returned array keeps its identity until an entry's result changes. A tuple
 * dropped from the list is released as `options.release` says.
 */
function useValueList(
  value: LiveValue<unknown, Record<string, string>, LiveValueOrigin>,
  list: readonly (Record<string, string> | null)[],
  options: LiveValueListOptions = {},
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
  const results = useResources(
    value,
    plan.distinct,
    options.release === "now" ? RELEASE_NOW : KEEP_ALIVE,
  );
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
  options?: LiveValueListOptions,
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
    options,
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
  // `{ where: null }`: a scope not known yet — the substrate's skip (pending,
  // nothing read), like a `null` id.
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
  where?: Record<string, string> | null;
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
  const ids = (query as { ids?: readonly string[] }).ids;
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
 * One row by id (`useLive(c, { id })`): the `:rows` point sibling at a one-id
 * set — so it ignores every window filter and bound: it answers "does this
 * row exist". A `null` id, or one the point codec cannot carry (`""`, one
 * holding a `,` — the wire set is comma-joined), is {@link NO_ID} from the
 * first render and reads nothing (the substrate's skip). The machine arm is
 * `useLive`'s own read kind (`"unavailable"`), decided before this.
 */
function useRow<Row>(
  collection: LiveRowsCollection<Row>,
  id: string | null,
): LiveRowResult<CollectionRow<Row>> {
  const absent = id === null || !isPointId(id);
  const idsKey = absent ? null : collection.rows.point.encode([id]).ids;
  const params = useMemo(
    () => (idsKey === null ? null : { ids: idsKey }),
    [idsKey],
  );
  const result = useResource(collection.rows, params);
  // The result keeps its identity until what it is built from changes, like
  // the list result: consumers memoize on it. `useResource`'s own result
  // changes only with its status / data / error / stale.
  return useMemo((): LiveRowResult<CollectionRow<Row>> => {
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
  }, [absent, result]);
}

/**
 * One row by id with its ancestors (`useLive(tree, { id, include:
 * "ancestors" })`): {@link useRow}, and on its ready arm the row's parent
 * chain, root-first (none for a root or a row not found) — `loading` until
 * the chain is known.
 */
function useTreeRow<Row>(
  collection: LiveTreeCollection<Row, unknown, string>,
  id: string | null,
): WithAncestors<LiveRowResult<CollectionRow<Row>>, CollectionRow<Row>> {
  const read = useRow(collection, id);
  const row =
    read.status !== "ready" ? undefined : read.found ? (read.row as Row) : null;
  const ancestors = useRowAncestors(collection, row);
  return useMemo(() => {
    if (read.status !== "ready") return read;
    switch (ancestors.status) {
      case "loading":
        return { status: "loading", refetch: read.refetch };
      case "error":
        return {
          status: "error",
          error: ancestors.error,
          ...(read.found ? { stale: read.row } : {}),
          refetch: ancestors.refetch,
        };
      case "ready":
        return {
          ...read,
          ancestors: ancestors.rows as readonly CollectionRow<Row>[],
          ancestorsPending: false,
        };
    }
  }, [read, ancestors]) as WithAncestors<
    LiveRowResult<CollectionRow<Row>>,
    CollectionRow<Row>
  >;
}
