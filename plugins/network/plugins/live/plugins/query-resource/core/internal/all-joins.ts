// The join kinds only a collection declared `all` reads
// (research/2026-10-06-global-scoped-change-routing-p8-v3.md, §4.1, C9; v2's
// "Join kinds"): a whole ordered set is computed set-at-a-time — grouped CTEs
// hash-joined to the base — so beside the window joins (`JoinSpec`) it may
// read
//
// - `rollup`   — a `derived-tables` rollup (`defineRollup`), N:1 on its key:
//                `on` is a base column (its pk or not) or an earlier join's;
// - `children` — the rows of a child table naming the host by `fk`, read only
//                through the AGGREGATES declared over them (`aggregate`,
//                `jsonAgg`), optionally with rollups keyed by a child column;
// - `closure`  — the transitive ancestors of the host over an edge table
//                (`child` → `parent`, cycles terminate), read only through
//                aggregates over the ancestor rows and the joins hung off
//                each ancestor.
//
// `AllJoinSpec` is the union; only the `all` compiler takes it. Every other
// compile (a window, a grouping, a union arm, a column override, a contributed
// column) keeps `JoinSpec`, so a rollup, children or closure join there is a
// tsc error (A24 / C9) — a grouping has no rows to aggregate per host.
//
// A children or closure join exposes ONLY its aggregates to the row
// (`AllJoinRefs`): `j.<alias>.<aggregate>` is an `AggregateRef`, and a raw
// child column cannot be spelled — a host has many children, so one of their
// columns is not a value of the host.
//
// The aggregate callbacks are DATA the server compiler runs: it hands each one
// refs that render against the relation's internal alias (`<a>` for a
// child, `<a>__<r>` for a rollup under it, `<a>__anc` for an ancestor row,
// `<a>__anc__<r>` for a join hung off it — the relation names typed below), and
// reads the aggregate's provenance off the SQL it returns.
//
// A rollup's columns are typed through `OuterColumnRef`: every rollup is
// LEFT-joined, so a host with no rollup row reads them NULL whatever the
// rollup table's own NOT NULL says — a `jsonAgg` element field over one is
// `| null` (A33's reasoning, applied to the columns an aggregate reads).
//
// Browser-safe: type-only drizzle imports (no `sql` here — an `ifNone` is
// written where the join is declared, in server code).

import type { GetDecoderResult, SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Rollup } from "@plugins/database/plugins/derived-tables/core";
import { SQL_TYPE_RE, type ExprDecoder } from "./expr";
import type {
  BASE_RELATION,
  ColumnRef,
  ColumnRefsOf,
  JoinSpec,
  JoinWireColumns,
  TypedColumnRef,
} from "./joins";

// ── Aggregates ─────────────────────────────────────────────────────────

declare const aggregateValue: unique symbol;
declare const aggregateForm: unique symbol;

/**
 * Which form an aggregate's value reaches the row in:
 *
 * - `decoded` — run through its declared decoder ({@link aggregate}): exactly
 *   the value type, a `timestamptz` a `Date`;
 * - `json` — the JSON the driver parsed, untouched ({@link jsonAgg}): every
 *   `timestamptz` already the ISO-UTC text the compiler rendered, so it is
 *   the JSON form of a row field (a `Date` field's ISO string).
 *
 * Carried as a phantom so a consumer binding an aggregate to a row field can
 * admit the JSON form for a `jsonAgg` only — a scalar aggregate's text form of
 * a `timestamptz` is Postgres's, not ISO.
 */
export type AggregateForm = "decoded" | "json";

/**
 * The runtime brand only {@link aggregate} and {@link jsonAgg} set —
 * unexported, so an object literal cannot spell an `Aggregate` (tsc) and
 * {@link isAggregate} rejects one cast into shape.
 */
const AGGREGATE_BRAND: unique symbol = Symbol("Aggregate");

/** A sort direction. */
export type AggregateOrder = "asc" | "desc";

/**
 * What an aggregate computes per host:
 *
 * - `expr` — a grouped SQL expression over the group's refs
 *   (`bool_or(${c.att.status} = 'completed')`); `ifNone` is what a host with
 *   no group row reads (`COALESCE(<out>, <ifNone>)`), `null` = NULL;
 * - `json` — the group's rows as a JSON array of `columns`, ordered by
 *   `orderBy` (the pk breaks ties); a host with no group row reads `[]`.
 *   Rendered by the compiler (a `timestamptz` as an ISO-8601 `Z` string), so
 *   the SQL is not the declaration's to write.
 */
export type AggregateShape =
  | { readonly kind: "expr"; readonly sql: SQL; readonly ifNone: SQL | null }
  | {
      readonly kind: "json";
      readonly columns: Readonly<
        Record<string, TypedColumnRef<string, PgColumn>>
      >;
      readonly orderBy: readonly (readonly [
        TypedColumnRef<string, PgColumn>,
        AggregateOrder,
      ])[];
    };

/**
 * One value per host computed over a group of rows (a children join's, a
 * closure's ancestors). `V` is its value type on the wire. Made by
 * {@link aggregate} or {@link jsonAgg} only.
 */
export interface Aggregate<
  V = unknown,
  F extends AggregateForm = AggregateForm,
> {
  readonly kind: "aggregate";
  /** Set by {@link aggregate} / {@link jsonAgg} only — see `AGGREGATE_BRAND`. */
  readonly [AGGREGATE_BRAND]: true;
  readonly shape: AggregateShape;
  readonly decoder: ExprDecoder;
  /** The SQL type the aggregate produces (checked against `SQL_TYPE_RE`). */
  readonly sqlType: string;
  /** The value is never NULL — a host with no group row included (`ifNone`). */
  readonly notNull: boolean;
  /** Phantom: the value type (covariant). */
  readonly [aggregateValue]?: V;
  /** Phantom: the form the value reaches the row in (`AggregateForm`). */
  readonly [aggregateForm]?: F;
}

/** An aggregate's declared value, read off its phantom. */
export type AggregateValue<A> = A extends Aggregate<infer V> ? V : never;

/** An aggregate's value form (`AggregateForm`), read off its phantom. */
export type AggregateFormOf<A> =
  A extends Aggregate<unknown, infer F> ? F : never;

/** The aggregates a children or closure join declares, by name. */
export type AggregateSet = Readonly<Record<string, Aggregate>>;

interface AggregateOptions<D extends ExprDecoder> {
  /** Decodes the driver value: its result type is the aggregate's value type. */
  decoder: D;
  /** The SQL type the aggregate produces. */
  sqlType: string;
}

/**
 * Declare a grouped value: `expression` aggregates the group's rows (over the
 * refs the join's `aggregates` callback is handed).
 *
 * A33: a NON-NULL aggregate states `ifNone` — what a host with no group row
 * reads — because the grouped CTE is LEFT-joined and an empty group reads
 * NULL. Without `notNull: true` the value is `V | null`, and `ifNone` is
 * optional (absent = NULL).
 *
 * Throws on an `sqlType` that is not a Postgres type name, and on `notNull`
 * without `ifNone` (an untyped caller).
 */
export function aggregate<D extends ExprDecoder>(
  expression: SQL,
  opts: AggregateOptions<D> & { notNull: true; ifNone: SQL },
): Aggregate<GetDecoderResult<D>, "decoded">;
export function aggregate<D extends ExprDecoder>(
  expression: SQL,
  opts: AggregateOptions<D> & { notNull?: false; ifNone?: SQL },
): Aggregate<GetDecoderResult<D> | null, "decoded">;
export function aggregate(
  expression: SQL,
  opts: AggregateOptions<ExprDecoder> & { notNull?: boolean; ifNone?: SQL },
): Aggregate {
  assertSqlType("aggregate", opts.sqlType);
  const notNull = opts.notNull === true;
  if (notNull && opts.ifNone === undefined) {
    throw new Error(
      "aggregate: `notNull: true` needs `ifNone` — a host with no group row reads the LEFT-joined aggregate as NULL, so a non-null aggregate must say what it reads instead (A33).",
    );
  }
  return Object.freeze({
    kind: "aggregate",
    [AGGREGATE_BRAND]: true as const,
    shape: Object.freeze({
      kind: "expr",
      sql: expression,
      ifNone: opts.ifNone ?? null,
    }),
    decoder: opts.decoder,
    sqlType: opts.sqlType,
    notNull,
  });
}

/** A JSON-wire value of a column's stored type: a `Date` crosses as its ISO string. */
type JsonWire<T> = T extends Date ? string : T;

/**
 * One `jsonAgg` element field's value: the column's JSON form, `| null` unless
 * NOT NULL — and always `| null` for a column of an outer-joined relation (a
 * rollup's), which reads NULL for a host with no row there.
 */
type JsonAggField<R> =
  R extends OuterColumnRef<string, infer C>
    ? JsonWire<C["_"]["data"]> | null
    : R extends TypedColumnRef<string, infer C>
      ? C["_"]["notNull"] extends true
        ? JsonWire<C["_"]["data"]>
        : JsonWire<C["_"]["data"]> | null
      : never;

/** The element of a `jsonAgg` over `C`. */
export type JsonAggElement<
  C extends Readonly<Record<string, TypedColumnRef<string, PgColumn>>>,
> = { [K in keyof C]: JsonAggField<C[K]> };

/**
 * Declare a JSON array of the group's rows: one object per row, `columns` by
 * field name, ordered by `orderBy` (the compiler appends the pk tiebreaker).
 * Never NULL — a host with no group row reads `[]` — and decoded as the
 * driver hands it (`json`). Its element types are the columns' JSON forms; the
 * compiler refuses a column type outside text, boolean, integer, timestamptz,
 * json, jsonb and text[], and a `withWire` column (A39).
 *
 * Throws on no columns and on an empty `orderBy` (an array's order is part of
 * the value — it must not depend on a plan).
 */
export function jsonAgg<
  const C extends Readonly<Record<string, TypedColumnRef<string, PgColumn>>>,
>(
  columns: C,
  opts: {
    orderBy: readonly (readonly [
      TypedColumnRef<string, PgColumn>,
      AggregateOrder,
    ])[];
  },
): Aggregate<JsonAggElement<C>[], "json"> {
  if (Object.keys(columns).length === 0) {
    throw new Error("jsonAgg: no columns — an element must carry a field.");
  }
  if (opts.orderBy.length === 0) {
    throw new Error(
      "jsonAgg: an empty `orderBy` — the array's order is part of its value, so it must be declared, not left to the plan.",
    );
  }
  for (const [, dir] of opts.orderBy) {
    if (dir !== "asc" && dir !== "desc") {
      throw new Error(
        `jsonAgg: orderBy direction ${JSON.stringify(dir)} is neither "asc" nor "desc".`,
      );
    }
  }
  return Object.freeze({
    kind: "aggregate",
    [AGGREGATE_BRAND]: true as const,
    shape: Object.freeze({
      kind: "json",
      columns: Object.freeze({ ...columns }),
      orderBy: Object.freeze([...opts.orderBy]),
    }),
    decoder: jsonAggValue,
    sqlType: "json",
    notNull: true,
  });
}

/**
 * Every {@link jsonAgg}'s decoder: the json the driver already parsed, as is
 * — its shape is the SQL's (`json_build_object` of the declared columns). One
 * named function, so a persisted compile's definition names it by identity
 * (an anonymous decoder has no identity a definition can read).
 */
export function jsonAggValue(value: unknown): unknown {
  return value;
}

/**
 * Whether a value is an {@link Aggregate} made by {@link aggregate} or
 * {@link jsonAgg}. Reads the brand, never `kind`.
 */
export function isAggregate(value: unknown): value is Aggregate {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [AGGREGATE_BRAND]?: unknown })[AGGREGATE_BRAND] === true
  );
}

/**
 * A reference to one declared aggregate of relation `R` — what a children or
 * closure join exposes under `j.<alias>`. At runtime the compiler's refs also
 * render as SQL (the aggregate's grouped output, COALESCEd with its
 * `ifNone`), so an `ExprField` interpolates it like a column ref.
 */
export interface AggregateRef<
  R extends string,
  N extends string,
  V,
  F extends AggregateForm = AggregateForm,
> {
  readonly from: R;
  readonly aggregate: N;
  /** Phantom: the value type. */
  readonly [aggregateValue]?: V;
  /** Phantom: the form the value reaches the row in (the aggregate's). */
  readonly [aggregateForm]?: F;
}

/** The `AggregateRef` of every aggregate of `Ag`, as relation `R`, by name. */
export type AggregateRefsOf<R extends string, Ag extends AggregateSet> = {
  readonly [N in keyof Ag & string]: AggregateRef<
    R,
    N,
    AggregateValue<Ag[N]>,
    AggregateFormOf<Ag[N]>
  >;
};

// ── Outer-joined column refs ───────────────────────────────────────────

declare const outerJoined: unique symbol;

/**
 * A column of a relation joined LEFT (a rollup's): its value is NULL for a
 * host with no row there, whatever the column's own NOT NULL says. A
 * `TypedColumnRef` everywhere one is taken; the phantom only tells
 * `jsonAgg`'s element type to add `| null`. Never constructed by hand — the
 * compiler mints the refs it hands a callback.
 */
export interface OuterColumnRef<
  R extends string,
  C extends PgColumn,
> extends TypedColumnRef<R, C> {
  /** Phantom (type-only): the relation is outer-joined. */
  readonly [outerJoined]: true;
}

/** The `OuterColumnRef` of every column of `Cols`, as relation `R`, by property name. */
export type OuterColumnRefsOf<
  R extends string,
  Cols extends Readonly<Record<string, PgColumn>>,
> = {
  readonly [K in keyof Cols & string]: OuterColumnRef<R, Cols[K]>;
};

/** A rollup's columns, as relation `R` (outer: a host may have no row). */
type RollupRefsOf<R extends string, Ro extends Rollup> = OuterColumnRefsOf<
  R,
  Ro["handle"]["_"]["columns"]
>;

// ── Join kinds ─────────────────────────────────────────────────────────

/**
 * A `derived-tables` rollup, joined LEFT on its key: `on` (a base column — its
 * pk or any other — or an earlier join's) matches the rollup's key column. A
 * host with no rollup row reads its columns NULL (so they are
 * `OuterColumnRef`s).
 *
 * Its routes come from the rollup's SOURCES (`rollup.sources`: each source's
 * `carry` / `via`, gated by its `reads`), never from the rollup table, which no
 * route may name (A1): a write to a source reaches the hosts whose `on` names
 * the keys it moves. The table read is `rollup.handle` — the rollup's own, so a
 * join cannot pair one rollup's sources with another rollup's table.
 */
export interface RollupJoin<
  A extends string = string,
  T extends PgTable = PgTable,
> {
  readonly kind: "rollup";
  readonly alias: A;
  /** The rollup, as `defineRollup` minted it — its sources are the routes, its `handle` the read. */
  readonly rollup: Rollup<T>;
  readonly on: ColumnRef;
}

/**
 * A rollup hung off a children join's child rows or a closure's ancestor row:
 * `on` is a column of that host relation (the child table's, or the base
 * table's for an ancestor), matched against the rollup's key.
 */
export interface NestedRollupJoin<
  A extends string = string,
  T extends PgTable = PgTable,
> {
  readonly kind: "rollup";
  readonly alias: A;
  readonly rollup: Rollup<T>;
  /**
   * A column of the host relation (its table's own column object) — asserted
   * by `childrenJoin` / `closureJoin`.
   */
  readonly on: PgColumn;
}

/**
 * Nothing to name: the refs of a join whose alias is not a literal — the wide
 * `ChildrenJoin` / `ClosureJoin` a collection of joins is typed by. Every
 * declared join's refs are assignable to it, which is what lets a join over
 * one table be one of a list (its callbacks are methods, compared bivariantly).
 */
type NoRefs = Readonly<Record<never, never>>;

/** The refs a children join's `where` and `aggregates` are written over. */
export type ChildRefs<
  A extends string,
  T extends PgTable,
  R extends readonly NestedRollupJoin[],
> = string extends A
  ? NoRefs
  : { readonly [K in A]: ColumnRefsOf<A, T["_"]["columns"]> } & {
      readonly [S in R[number] as S["alias"]]: RollupRefsOf<
        `${A}__${S["alias"]}`,
        S["rollup"]
      >;
    };

/**
 * The rows of a child table that name their host by `fk` (the host's pk
 * value): the base row's, or — under a closure — an ancestor's. Read only
 * through `aggregates`; `where` filters the child rows first; `rollups` hang
 * off each child row (keyed by a child column) and are readable by the
 * aggregates.
 *
 * Its route is an `alias` on `fk` (a child row I / U / D is a host change),
 * gated by `fk`, the child pk, the `where` reads and the aggregate reads; a
 * nested rollup's source write reaches its host through the child row
 * (`<a>.<r>[<src>]`).
 */
export interface ChildrenJoin<
  A extends string = string,
  T extends PgTable = PgTable,
  R extends readonly NestedRollupJoin[] = readonly NestedRollupJoin[],
  Ag extends AggregateSet = AggregateSet,
> {
  readonly kind: "children";
  readonly alias: A;
  readonly table: T;
  /** The child column holding the host's pk. */
  readonly fk: PgColumn;
  readonly rollups: R;
  // Method signatures, not function-typed fields: a method's parameter is
  // compared bivariantly, so a join over one table still IS a `ChildrenJoin`
  // (its refs are a subtype of the wide default's, never a supertype).
  /** The child rows a host aggregates; absent = all of them. */
  where?(c: ChildRefs<A, T, R>): SQL;
  aggregates(c: ChildRefs<A, T, R>): Ag;
}

/** What may hang off a closure's ancestor row: a rollup, or its children. */
export type AncestorJoin = NestedRollupJoin | ChildrenJoin;

/** The name of a closure's ancestor relation. */
export type AncestorRelation<A extends string> = `${A}__anc`;

/** The refs a closure's `aggregates` are written over. */
export type ClosureRefs<
  A extends string,
  N extends PgTable,
  J extends readonly AncestorJoin[],
> = string extends A
  ? NoRefs
  : {
      /** The ancestor row — a row of the base table. */
      readonly anc: ColumnRefsOf<AncestorRelation<A>, N["_"]["columns"]>;
    } & {
      readonly [S in J[number] as S["alias"]]: S extends ChildrenJoin
        ? AggregateRefsOf<
            `${AncestorRelation<A>}__${S["alias"]}`,
            ReturnType<S["aggregates"]>
          >
        : S extends NestedRollupJoin
          ? RollupRefsOf<`${AncestorRelation<A>}__${S["alias"]}`, S["rollup"]>
          : never;
    };

/**
 * The transitive ancestors of the host: walk `edges` from the host's pk
 * (`child`) to the node it depends on (`parent`), repeatedly — `UNION`, so a
 * cycle terminates. An ancestor is a row of the base table (`nodes`); the
 * `ancestorJoins` hang off each ancestor row, and `aggregates` fold the set
 * (`bool_or(<ancestor is blocking>)`). A host with no ancestor reads each
 * aggregate's `ifNone`.
 *
 * Its routes: an `alias` on `child`, the dependents expansion `<a>:closure`
 * (a change to one node reaches every node that has it as an ancestor), gated
 * by `child`, `parent` and the columns the aggregates read on the ancestor.
 */
export interface ClosureJoin<
  A extends string = string,
  N extends PgTable = PgTable,
  J extends readonly AncestorJoin[] = readonly AncestorJoin[],
  Ag extends AggregateSet = AggregateSet,
> {
  readonly kind: "closure";
  readonly alias: A;
  /** The edge table: one row per (dependent, depended-on) pair. */
  readonly edges: PgTable;
  /** The edge column naming the dependent node (a base pk value). */
  readonly child: PgColumn;
  /** The edge column naming the node it depends on. */
  readonly parent: PgColumn;
  /** The base table: an ancestor is one of its rows. */
  readonly nodes: N;
  readonly ancestorJoins: J;
  /** A method signature for the reason `ChildrenJoin.aggregates` is one. */
  aggregates(c: ClosureRefs<A, N, J>): Ag;
}

/** Every join the `all` compiler reads. Every other compile takes `JoinSpec`. */
export type AllJoinSpec<A extends string = string> =
  JoinSpec<A> | RollupJoin<A> | ChildrenJoin<A> | ClosureJoin<A>;

/** The refs one join exposes to the row: a children or closure join's aggregates, else its columns. */
export type AllJoinRefsOf<S extends AllJoinSpec> = S extends
  ChildrenJoin | ClosureJoin
  ? AggregateRefsOf<S["alias"], ReturnType<S["aggregates"]>>
  : S extends RollupJoin
    ? RollupRefsOf<S["alias"], S["rollup"]>
    : S extends JoinSpec
      ? ColumnRefsOf<S["alias"], JoinWireColumns<S>>
      : never;

/**
 * The `j` of an `all` collection's column override: `j.base` the base
 * source's wire columns, a window join's or a rollup's columns under its alias,
 * and a children or closure join's AGGREGATES only (`AggregateRef`) — a raw
 * child column is not a value of the host, so it cannot be spelled.
 */
export type AllJoinRefs<
  BaseCols extends Readonly<Record<string, PgColumn>>,
  J extends readonly AllJoinSpec[],
> = {
  readonly base: ColumnRefsOf<typeof BASE_RELATION, BaseCols>;
} & {
  readonly [S in J[number] as S["alias"]]: AllJoinRefsOf<S>;
};

// ── Builders ───────────────────────────────────────────────────────────
//
// Children and closure joins are made by a builder, not written as literals:
// their `aggregates` callback is typed by the join's own table and nested
// joins, which TypeScript infers from the spec's other fields only through a
// generic call (as `expr`'s header explains for `j`).

/**
 * Declare a children join (see {@link ChildrenJoin}). Throws on an empty
 * alias, on a nested rollup alias that repeats another or the join's own, on
 * an `fk` that is not a column of `table`, and on a nested rollup whose `on`
 * is not a column of `table` (the child row it hangs off).
 */
export function childrenJoin<
  const A extends string,
  T extends PgTable,
  Ag extends AggregateSet,
  const R extends readonly NestedRollupJoin[] = readonly [],
>(spec: {
  alias: A;
  table: T;
  fk: PgColumn;
  rollups?: R;
  where?: (c: ChildRefs<A, T, R>) => SQL;
  aggregates: (c: ChildRefs<A, T, R>) => Ag;
}): ChildrenJoin<A, T, R, Ag> {
  assertAlias("childrenJoin", spec.alias);
  const where = `childrenJoin("${spec.alias}")`;
  assertColumnOf(where, "fk", spec.fk, spec.table, "table");
  const rollups = (spec.rollups ?? []) as unknown as R;
  assertNestedAliases(
    where,
    [spec.alias],
    rollups.map((r) => r.alias),
  );
  for (const r of rollups) {
    assertColumnOf(
      where,
      `rollups["${r.alias}"].on`,
      r.on,
      spec.table,
      "table",
    );
  }
  return Object.freeze({
    kind: "children",
    alias: spec.alias,
    table: spec.table,
    fk: spec.fk,
    rollups: Object.freeze([...rollups]) as unknown as R,
    ...(spec.where === undefined ? {} : { where: spec.where }),
    aggregates: spec.aggregates,
  });
}

/**
 * Declare a closure join (see {@link ClosureJoin}). Throws on an empty alias,
 * on `child` = `parent`, on a `child` or `parent` that is not a column of
 * `edges`, on an ancestor join alias that repeats another or is `anc` (the
 * ancestor row's own name in `aggregates`), and on an ancestor rollup whose
 * `on` is not a column of `nodes` (the ancestor row it hangs off).
 */
export function closureJoin<
  const A extends string,
  N extends PgTable,
  Ag extends AggregateSet,
  const J extends readonly AncestorJoin[] = readonly [],
>(spec: {
  alias: A;
  edges: PgTable;
  child: PgColumn;
  parent: PgColumn;
  nodes: N;
  ancestorJoins?: J;
  aggregates: (c: ClosureRefs<A, N, J>) => Ag;
}): ClosureJoin<A, N, J, Ag> {
  assertAlias("closureJoin", spec.alias);
  const where = `closureJoin("${spec.alias}")`;
  assertColumnOf(where, "child", spec.child, spec.edges, "edges");
  assertColumnOf(where, "parent", spec.parent, spec.edges, "edges");
  if (spec.child === spec.parent) {
    throw new Error(
      `closureJoin("${spec.alias}"): \`child\` and \`parent\` are the same column — an edge names two nodes.`,
    );
  }
  const ancestorJoins = (spec.ancestorJoins ?? []) as unknown as J;
  assertNestedAliases(
    where,
    ["anc"],
    ancestorJoins.map((j) => j.alias),
  );
  for (const j of ancestorJoins) {
    if (j.kind === "rollup") {
      assertColumnOf(
        where,
        `ancestorJoins["${j.alias}"].on`,
        j.on,
        spec.nodes,
        "nodes",
      );
    }
  }
  return Object.freeze({
    kind: "closure",
    alias: spec.alias,
    edges: spec.edges,
    child: spec.child,
    parent: spec.parent,
    nodes: spec.nodes,
    ancestorJoins: Object.freeze([...ancestorJoins]) as unknown as J,
    aggregates: spec.aggregates,
  });
}

function assertSqlType(where: string, sqlType: string): void {
  if (!SQL_TYPE_RE.test(sqlType)) {
    throw new Error(
      `${where}: sqlType "${sqlType}" is not a Postgres type name (${SQL_TYPE_RE.source}) — it is interpolated raw into casts.`,
    );
  }
}

/**
 * A declared column must be the named table's own column object — a column of
 * another table would compile to a reference the relation does not have.
 */
function assertColumnOf(
  where: string,
  field: string,
  col: PgColumn,
  table: PgTable,
  tableField: string,
): void {
  if (col.table !== table) {
    throw new Error(
      `${where}: \`${field}\` (column "${col.name}") is not a column of \`${tableField}\` — a column of another table would compile to a reference that relation does not have.`,
    );
  }
}

function assertAlias(where: string, alias: string): void {
  if (alias.length === 0) throw new Error(`${where}: an empty alias`);
}

function assertNestedAliases(
  where: string,
  reserved: readonly string[],
  aliases: readonly string[],
): void {
  const seen = new Set(reserved);
  for (const alias of aliases) {
    if (alias.length === 0) throw new Error(`${where}: an empty nested alias`);
    if (seen.has(alias)) {
      throw new Error(
        `${where}: the nested alias "${alias}" repeats ${reserved.includes(alias) ? "a reserved name" : "another"} — each relation a join reads is named once.`,
      );
    }
    seen.add(alias);
  }
}
