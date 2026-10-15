import type {
  Filter,
  FilterColumn,
  FilterDomainId,
  FilterOperand,
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

export type LiveSortDirection = "asc" | "desc";

/** Sort keys, most significant first. The server appends the id as tiebreaker. */
export type LiveOrderBy<S extends string> = readonly (readonly [
  S,
  LiveSortDirection,
])[];

/** A window query. Every part defaults to the declaration's `default`. */
export interface LiveQuery<F, S extends string> {
  where?: LiveWhere<F>;
  orderBy?: LiveOrderBy<S>;
  limit?: number;
  /**
   * The column sets (exposures, arms, scoped sets) this query's `where` /
   * `orderBy` name by wire name (`<set>.<field>`) — what the codec
   * validates those names against. Not part of the wire params.
   */
  columns?: readonly LiveColumnsDeclaration[];
  /** A grouping is its own query shape — {@link LiveGroupQuery}. */
  groupBy?: never;
  /** A total is its own query shape — {@link LiveCountQuery}. */
  count?: never;
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
  G extends LiveGroupableColumn<F> = LiveGroupableColumn<F>,
> {
  groupBy: G;
  where?: LiveWhere<F>;
  limit?: number;
  /**
   * The column sets (an exposure's `exposedColumns`) its `groupBy` / `where`
   * name by wire name — what the codec validates those names against. Not
   * part of the wire params.
   */
  columns?: readonly LiveColumnsDeclaration[];
  orderBy?: never;
}

/**
 * A total: how many of the collection's rows match `where` — one number,
 * pushed whole and recomputed on every write to a table it reads. Only on a
 * collection declared `count: true` (its author's statement that the COUNT is
 * cheap enough to keep live).
 */
export interface LiveCountQuery<F> {
  count: true;
  where?: LiveWhere<F>;
  /** The column sets its `where` names by wire name (see {@link LiveQuery.columns}). */
  columns?: readonly LiveColumnsDeclaration[];
  groupBy?: never;
  orderBy?: never;
  limit?: never;
}

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
};

/**
 * The count resource's wire params: `where` as the window's canonical filter
 * encoding, present only when not the absent filter — so the total of the
 * whole collection is the param-less `{}` tuple (the one a preload hydrates).
 */
export type LiveCountParams = {
  where?: string;
};

/** A decoded count query. */
export interface LiveDecodedCountQuery {
  /** The canonical filter (validated by the strict decode); `undefined` when unfiltered. */
  where: Filter | undefined;
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
}

/** A decoded grouping query with every default filled in. */
export interface LiveDecodedGroupQuery<C extends string> {
  groupBy: C;
  limit: number;
  /** The canonical filter (validated by the strict decode); `undefined` when unfiltered. */
  where: Filter | undefined;
}
