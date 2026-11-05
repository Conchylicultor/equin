import type {
  Filter,
  FilterColumn,
  FilterDomainId,
  FilterOperand,
  Filterable,
  OperandKindOf,
  OpsFor,
} from "@plugins/network/plugins/live/plugins/filter/core";

import type { LiveColumnsDeclaration } from "./live-columns";
import type { LiveCutKey } from "./row-key";

// The consumer-facing query language, typed against a collection's
// declaration: an undeclared column, an op the column's domain does not take,
// a wrong operand type or a non-sortable `orderBy` column fails in tsc. The
// filter itself is the one filter language
// (`@plugins/network/plugins/live/plugins/filter`); this file only adds the
// per-column object sugar and the window / grouping query shapes.

/** The row values a column of each domain may hold (NULL aside). */
interface DomainRowValue {
  text: string;
  number: number;
  boolean: boolean;
  instant: Date | string;
  stringArray: readonly string[];
}

/** The domains a row field of type `T` may be declared as. */
type DomainsFor<T> = {
  [D in FilterDomainId]: [T] extends [DomainRowValue[D]] ? D : never;
}[FilterDomainId];

/**
 * The declared filterable columns: row field → its domain constructor
 * (`liveText(StatusSchema)`, `liveBoolean()` …). The domain must fit the row
 * field's type — a `liveInstant()` over a string field is a tsc error.
 */
export type LiveFilterable<Row> = {
  readonly [K in keyof Row & string]?: FilterColumn<
    DomainsFor<NonNullable<Row[K]>>,
    unknown
  >;
};

/**
 * Keys a `where` object uses to spell a `Filter` tree, which therefore cannot
 * be filterable column names (the sugar and the tree would be ambiguous).
 */
export type LiveReservedColumn = "and" | "or" | "column" | "op" | "operand";

type DomainOf<Col> = Col extends FilterColumn<infer D> ? D : never;
type OperandTypeOf<Col> =
  Col extends FilterColumn<FilterDomainId, infer V> ? V : never;

type ExactlyOne<T> = {
  [K in keyof T]: { [P in K]: T[P] } & { [P in Exclude<keyof T, K>]?: never };
}[keyof T];

/** Every op a column takes, as `{ op: operand }` — a no-operand op is spelled `{ isEmpty: true }`. */
type ColumnOps<Col> = {
  [K in OpsFor<DomainOf<Col>>]: OperandKindOf<K> extends "none"
    ? true
    : FilterOperand<K, OperandTypeOf<Col>>;
};

/** One column's sugar: a plain value (meaning `eq`, where the domain takes it) or exactly one op. */
export type LiveColumnFilter<Col> =
  | ("eq" extends OpsFor<DomainOf<Col>> ? OperandTypeOf<Col> : never)
  | ExactlyOne<ColumnOps<Col>>;

/** The per-column object sugar: an AND across declared columns. */
export type LiveWhereObject<F> = {
  [K in keyof F]?: LiveColumnFilter<F[K]>;
};

/** `F` as the filter language's declaration shape. */
export type LiveFilterableOf<F> = {
  readonly [K in keyof F & string]: F[K] extends FilterColumn ? F[K] : never;
};

/**
 * A window / grouping filter: the per-column object sugar, or a `Filter` tree
 * (`or(...)`, `and(...)`, `clause(...)`). Both canonicalize to the same tree
 * and the same wire bytes. No clock: no op's answer depends on the current time.
 */
export type LiveWhere<F> = LiveWhereObject<F> | Filter<LiveFilterableOf<F>>;

type UnionToIntersection<U> = (
  U extends unknown ? (u: U) => void : never
) extends (i: infer I) => void
  ? I
  : never;

/** The column-set declarations a query's `columns` (`C`) holds; `never` for none. */
type BroughtSets<C> = C extends readonly (infer E)[] ? E : never;

/** The wire filter vocabulary of each brought set, as a union. */
type BroughtFilterable<C> =
  BroughtSets<C> extends infer E
    ? E extends { readonly wireFilterable: infer WF }
      ? WF
      : never
    : never;

/** The sortable wire names of the brought sets. */
type BroughtSortable<C> =
  BroughtSets<C> extends infer E
    ? E extends { readonly wireSortable: readonly (infer WS)[] }
      ? WS
      : never
    : never;

/**
 * The filter vocabulary of a query on a collection with filterable columns
 * `F` that brings the column sets `C` (its `columns`): the collection's own,
 * plus every set's wire vocabulary (an exposure's `tasks_ext_track.track`) —
 * so a `where` naming a brought column type-checks like an own one, and one
 * naming a column the query does not bring is a tsc error. A brought set
 * whose names are not known statically (an erased `LiveColumnsDeclaration` —
 * a list lowering a saved filter over whatever sets it holds) makes the whole
 * vocabulary open: such a `where` is the untyped filter language, checked by
 * the codec at runtime as before.
 */
export type LiveQueryFilterable<F, C> = [BroughtSets<C>] extends [never]
  ? F
  : BringsOpenSet<C> extends true
    ? Filterable
    : F & UnionToIntersection<BroughtFilterable<C>>;

/** Whether a brought set's names are not known statically (an erased declaration). */
type BringsOpenSet<C> = string extends keyof UnionToIntersection<
  BroughtFilterable<C>
>
  ? true
  : false;

/**
 * The `where` of a query on a collection with filterable columns `F` that
 * brings the column sets `C`: over the vocabulary {@link LiveQueryFilterable}
 * — or, bringing a set whose names are not known statically, either the
 * collection's own typed `where` or the untyped filter language (a query
 * typed by its declaration keeps its own `where`'s check).
 */
export type LiveQueryWhere<F, C> = [BroughtSets<C>] extends [never]
  ? LiveWhere<F>
  : BringsOpenSet<C> extends true
    ? LiveWhere<F> | LiveWhere<Filterable>
    : LiveWhere<F & UnionToIntersection<BroughtFilterable<C>>>;

/** The sortable columns of a query bringing the column sets `C` (see {@link LiveQueryFilterable}). */
export type LiveQuerySortable<S extends string, C> = [BroughtSets<C>] extends [
  never,
]
  ? S
  : string extends BroughtSortable<C>
    ? string
    : S | (BroughtSortable<C> & string);

export type LiveSortDirection = "asc" | "desc";

/** Sort keys, most significant first. The server appends the id as tiebreaker. */
export type LiveOrderBy<S extends string> = readonly (readonly [
  S,
  LiveSortDirection,
])[];

/**
 * A window query. Every part defaults to the declaration's `default`. `W` is
 * its `where` — over `F` unless the query brings column sets
 * ({@link LiveQueryWhere}).
 */
export interface LiveQuery<F, S extends string, W = LiveWhere<F>> {
  where?: W;
  orderBy?: LiveOrderBy<S>;
  limit?: number;
  /**
   * The column sets (exposures, arms, scoped sets) this query's `where` /
   * `orderBy` name by wire name (`<set>.<field>`) — what the codec
   * validates those names against. Not part of the wire params.
   */
  columns?: readonly LiveColumnsDeclaration[];
  /**
   * The reader's pinned clock (epoch ms, floored to the clock field's
   * quantum) — present exactly when `where` / `orderBy` names a clock field
   * (`clockField`): `useLive` fills and re-pins it; a server reader passes
   * it. A query reading no clock field carries none (the codec refuses both
   * mistakes).
   */
  now?: number;
  /** A grouping is its own query shape — {@link LiveGroupQuery}. */
  groupBy?: never;
  /** A total is its own query shape — {@link LiveCountQuery}. */
  count?: never;
  /** One row is its own query shape — {@link LiveRowQuery}. */
  id?: never;
  /** An id set is its own query shape — {@link LiveIdsQuery}. */
  ids?: never;
}

/** The domains a grouping may group on — one chip per scalar value. */
export type LiveGroupableDomain = "text" | "number" | "boolean";

/** The filterable columns of a groupable domain. */
export type LiveGroupableColumn<F> = {
  [K in keyof F & string]: DomainOf<F[K]> extends LiveGroupableDomain
    ? K
    : never;
}[keyof F & string];

/**
 * The columns a grouping bringing the column sets `C` may group by (see
 * {@link LiveQueryFilterable}) — any name when a brought set's names are not
 * known statically (the codec checks it).
 */
export type LiveQueryGroupable<F, C> =
  BringsOpenSet<C> extends true
    ? string
    : LiveGroupableColumn<LiveQueryFilterable<F, C>>;

/**
 * A grouping query: the values the filterable column `G` takes across the
 * collection's rows matching `where`, one `{ value, count }` per value. The
 * order is fixed — count descending, then value (code-point order) — so there
 * is no `orderBy`. `limit` bounds how many groups come back (default
 * {@link LIVE_GROUP_DEFAULT_LIMIT}, max the filter language's `LIST_MAX`: a
 * picked set of groups must still fit one `in` filter).
 *
 * `G` must be a `text` / `number` / `boolean` column. `where` applies as given:
 * to keep every chip visible while one is picked, leave the grouped column out.
 */
export interface LiveGroupQuery<
  F,
  G extends string = LiveGroupableColumn<F>,
  W = LiveWhere<F>,
> {
  groupBy: G;
  where?: W;
  limit?: number;
  /**
   * The column sets (an exposure's `exposedColumns`) its `groupBy` / `where`
   * name by wire name — what the codec validates those names against. Not
   * part of the wire params.
   */
  columns?: readonly LiveColumnsDeclaration[];
  /**
   * The reader's pinned clock (epoch ms, floored to the clock field's
   * quantum) — present exactly when `where` / `orderBy` names a clock field
   * (`clockField`): `useLive` fills and re-pins it; a server reader passes
   * it. A query reading no clock field carries none (the codec refuses both
   * mistakes).
   */
  now?: number;
  orderBy?: never;
  id?: never;
  ids?: never;
}

/**
 * A total: how many of the collection's rows match `where` — one number,
 * pushed whole and recomputed on every write to a table it reads. Only on a
 * collection declared `count: true` (its author's statement that the COUNT is
 * cheap enough to keep live).
 */
export interface LiveCountQuery<F, W = LiveWhere<F>> {
  count: true;
  where?: W;
  /** The column sets its `where` names by wire name (see {@link LiveQuery.columns}). */
  columns?: readonly LiveColumnsDeclaration[];
  /**
   * The reader's pinned clock (epoch ms, floored to the clock field's
   * quantum) — present exactly when `where` / `orderBy` names a clock field
   * (`clockField`): `useLive` fills and re-pins it; a server reader passes
   * it. A query reading no clock field carries none (the codec refuses both
   * mistakes).
   */
  now?: number;
  groupBy?: never;
  orderBy?: never;
  limit?: never;
  id?: never;
  ids?: never;
}

/**
 * An explicit id set (`useLive(c, { ids })`): the rows of the `:rows` point
 * sibling for the ids that exist, unordered. No filter, order or bound
 * applies — an id set is not a window.
 */
export interface LiveIdsQuery {
  ids: readonly string[];
  id?: never;
  where?: never;
  orderBy?: never;
  limit?: never;
  groupBy?: never;
  count?: never;
  columns?: never;
  now?: never;
}

/**
 * One row by id (`useLive(c, { id })`): the `:rows` point sibling at a
 * one-id set. `null` — or an id no point set can carry (`""`, one holding a
 * `,`) — is a determinate not-found from the first render, nothing read.
 */
export interface LiveRowQuery {
  id: string | null;
  ids?: never;
  where?: never;
  orderBy?: never;
  limit?: never;
  groupBy?: never;
  count?: never;
  columns?: never;
  now?: never;
}

/**
 * The scope of a collection declared `all: { by }` (`useLive(c, { where })`):
 * exactly its `by` fields, each a string — a `Filter` tree, an op, a missing
 * or an extra field is a tsc error. The record IS the tuple's params. `never`
 * for a set declared without `by`, which has one tuple.
 */
export type LiveScopedAllQuery<B extends string> = [B] extends [never]
  ? never
  : { where: { readonly [K in B]: string }; id?: never; ids?: never };

/** One group: a value of the grouped column (NULL is its own group) and how many rows carry it. */
export interface LiveGroup<V> {
  value: V | null;
  count: number;
}

/**
 * The value type of a group over column `G`: the ROW field's type — a group
 * value is a stored value, and the server checks each one against the row
 * schema's field (an operand narrowing like `liveText(Enum)` says nothing
 * about what the column holds).
 */
export type LiveGroupValue<Row, G extends string> = G extends keyof Row
  ? NonNullable<Row[G]>
  : never;

/**
 * The keys that name WHAT a collection query reads, most specific first: one
 * row, an id set, a total, a grouping, an `all` set's slice. A query holds at
 * most one of them (by value: a key holding `undefined` is absent); none is a
 * window, or an `all` set's whole set / scope. The one precedence list — the
 * runtime dispatch (`useLive`'s `readKindOf`) and the result type both read it.
 */
export const COLLECTION_KIND_KEYS = [
  "id",
  "ids",
  "count",
  "groupBy",
  "select",
] as const;

/** One key of {@link COLLECTION_KIND_KEYS}. */
export type CollectionKindKey = (typeof COLLECTION_KIND_KEYS)[number];

/** Default number of groups a grouping query returns. */
export const LIVE_GROUP_DEFAULT_LIMIT = 50;

/**
 * The window resource's wire params: `limit` always, `where` (the filter
 * language's `encodeFilter`) / `order` as canonical JSON present only when
 * they differ from the default, and a page's cuts (`after` / `until`)
 * present only when set. Additive string keys, so the default window stays
 * byte-identical `{ limit: "100" }`.
 */
export type LiveWindowParams = {
  limit: string;
  where?: string;
  order?: string;
  after?: string;
  until?: string;
  /** The pinned clock (canonical epoch-ms integer), exactly when the query reads a clock field. */
  now?: string;
  /**
   * The scope (a DataView surface id) of the scoped columns the query names,
   * exactly when its `where` / `orderBy` names one — the asking list's surface.
   */
  scope?: string;
};

/**
 * One page's bounds in a window's order: `after` an EXCLUSIVE
 * lower cut, `until` an INCLUSIVE upper one. Each is a row's `$key` exactly as
 * the server minted it (see {@link LIVE_ROW_KEY}) — never derived on the
 * client, whose decoded row lost the order columns' exact text (a `Date` holds
 * milliseconds; Postgres holds microseconds).
 */
export interface LiveWindowBounds {
  after?: string;
  until?: string;
}

/**
 * The groups resource's wire params: `groupBy` and `limit` always, `where` as
 * the window's canonical filter encoding, present only when not the absent filter.
 */
export type LiveGroupParams = {
  groupBy: string;
  limit: string;
  where?: string;
  now?: string;
};

/**
 * The count resource's wire params: `where` as the window's canonical filter
 * encoding, present only when not the absent filter — so the total of the
 * whole collection is the param-less `{}` tuple (the one a preload hydrates).
 */
export type LiveCountParams = {
  where?: string;
  now?: string;
};

/** A decoded count query. */
export interface LiveDecodedCountQuery {
  /** The canonical filter (validated by the strict decode); `undefined` when unfiltered. */
  where: Filter | undefined;
  /** The pinned clock, exactly when `where` reads a clock field. */
  now?: number;
}

/** A decoded query with every default filled in — what a server compiler consumes. */
export interface LiveDecodedQuery<S extends string> {
  limit: number;
  /** The canonical filter (validated by the strict decode); `undefined` when unfiltered. */
  where: Filter | undefined;
  orderBy: LiveOrderBy<S>;
  /** The page's exclusive lower cut; absent = the order's start. */
  after?: LiveCutKey;
  /** The page's inclusive upper cut; absent = the order's end. */
  until?: LiveCutKey;
  /** The pinned clock (epoch ms), exactly when `where` / `orderBy` reads a clock field. */
  now?: number;
  /** The scope of the scoped columns `where` / `orderBy` name, exactly when it names one. */
  scope?: string;
}

/** A decoded grouping query with every default filled in. */
export interface LiveDecodedGroupQuery<C extends string> {
  groupBy: C;
  limit: number;
  /** The canonical filter (validated by the strict decode); `undefined` when unfiltered. */
  where: Filter | undefined;
  /** The pinned clock, exactly when `where` reads a clock field. */
  now?: number;
}
