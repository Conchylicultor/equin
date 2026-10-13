import type { SQL } from "drizzle-orm";
import type { PgColumn, PgTable, PgView } from "drizzle-orm/pg-core";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import type { SqlExecutable } from "@plugins/database/plugins/sql-rows/core";
import type {
  JoinFamily,
  JoinSpec,
} from "@plugins/infra/plugins/query-resource/core";
import type {
  ResourceParams,
  RoutedRecomputeOn,
} from "@plugins/framework/plugins/resource-runtime/core";

// A structural view of an `infra/entities` Entity — exactly the subset the
// compiler reads (`name`, `table`, `wireColumns`, `schema`). A concrete
// `Entity<F, D, S>` satisfies this by construction, so the compiler detects and
// consumes an entity WITHOUT importing the full generic `Entity` type — whose
// generic-erased form (`Entity<FieldsRecord>`) fights assignability against a
// concrete entity. Detection is likewise structural (see `identity.ts`).
export interface EntitySource {
  readonly name: string;
  readonly table: PgTable;
  readonly wireColumns: Record<string, PgColumn>;
  readonly schema: ZodParser<unknown>;
}

/**
 * What a compile reads: a base table, or an entity (read through its
 * table) — never a view, whose changes arrive under its base tables' names
 * that no route of the view could state (A1 of
 * research/2026-09-29-global-scoped-change-routing.md).
 */
export type RoutedSource = PgTable | EntitySource;

/**
 * A drizzle select projection: JS key → column, an expression standing for
 * one (a defaulted extension column's COALESCE), a rendered `ExprField`
 * (`JoinPlan.renderExpr`), or an aliased expression.
 */
export type SelectMap = Record<string, PgColumn | SQL | SQL.Aliased>;

// The minimal chainable query surface the compiler drives: `select → from →
// optional where/orderBy/limit → await rows`. Kept deliberately small so
// neither the production default (the real drizzle `db`, cast once at the
// default-db boundary in `compile-window.ts`) nor the unit-test fake needs drizzle's
// full generics.
//
// The row shape is the CALLER's declaration, stated ONCE at the call that opens
// the query (`db.select<Row>(map)`) and flowing through `where`/`orderBy`/
// `limit` to the `await`. A compiler therefore never re-states it, and no query
// result needs an assertion to reach its declared type.
//
// Nothing about `Row` is guessed. Every public entry point
// (`windowQueryResource(contract, spec)`, `compileAllCollection`,
// `compileUnionCollection`) takes a contract, so a compiled resource's `Row` is
// pinned to the contract's `ZodParser<Row>` —
// and the runtime parses EVERY loader output against that same schema before
// the value is broadcast or cached
// (`plugins/framework/plugins/resource-runtime/core/runtime.ts`:
// `entry.schema.parse(await entry.loader(params, ctx))`). The seam declares the
// shape; the runtime is what verifies it, at one chokepoint, on every load.
export interface QueryStep<Row = unknown> extends PromiseLike<Row[]> {
  /** A declared join (`./joins`): the joined table under its alias, and its condition. */
  leftJoin(table: PgTable, on: SQL): QueryStep<Row>;
  /** A required (INNER) lookup — see `LookupJoin.required`. */
  innerJoin(table: PgTable, on: SQL): QueryStep<Row>;
  where(predicate: SQL): QueryStep<Row>;
  /** Aggregate reads (a collection's `:groups`); the compilers here never group. */
  groupBy(...columns: (PgColumn | SQL)[]): QueryStep<Row>;
  orderBy(...order: SQL[]): QueryStep<Row>;
  limit(count: number): QueryStep<Row>;
}
export interface QueryFrom<Row = unknown> {
  from(source: PgTable | PgView): QueryStep<Row>;
}
/**
 * The query surface: drizzle's builder, plus its raw `execute` — for the
 * shapes the builder cannot render (a union whose outer order keys are
 * expressions: drizzle's `unionAll` rewrites column chunks to bare
 * identifiers; a recursive CTE, which drizzle 0.36 has no builder for). Every
 * raw read goes through sql-rows' `executeRows(db, { query, row:
 * decodedRow(…), label })`, so its rows are decoded and checked like a
 * builder's.
 */
export interface QueryDb extends SqlExecutable<SQL> {
  select<Row = unknown>(fields?: SelectMap): QueryFrom<Row>;
  selectDistinct<Row = unknown>(fields: SelectMap): QueryFrom<Row>;
}

/**
 * One key of a bounded window's total order.
 *
 * RULE: the column MUST be UPDATE-STABLE (immutable post-insert — `createdAt`,
 * the pk, a fixed discriminator). The runtime's in-place path deliberately
 * skips `windowIdsOf` (a pure UPDATE ships one upsert, `order` omitted), so an
 * ORDER BY over a mutable column would leave the window's order stale until
 * the next membership delta — a correctness bug, not a staleness nit. Declared
 * as `{ col, dir }` pairs rather than raw `SQL` so the compiler can append the
 * pk tiebreaker (a strict total order — a window must be a prefix of it) and a
 * future cursor can derive its keyset seek from the same keys.
 */
export interface WindowOrderKey {
  /**
   * The column, as the SQL reads it: a base column, or a declared join's
   * rendered column (`JoinPlan.render` — a defaulted extension column is its
   * COALESCE expression) — whose NULLs a LEFT join may add, so the compiler
   * orders it NULLS LAST whatever `nullable` says.
   */
  col: PgColumn | SQL;
  /** Default `"asc"`. */
  dir?: "asc" | "desc";
  /** Nullable column → symmetric NULLS LAST handling (see `primitives/keyset`). Default `false`. */
  nullable?: boolean;
}

/**
 * The declarative input to `compileWindowQuery` / `windowQueryResource` — a
 * bounded-membership read, of one of two kinds matching the descriptor's: a
 * `liveCollection`'s window (`c.window`, {@link WindowQueryResourceSpec}) or
 * its `:rows` point sibling (`c.rows`, {@link PointQueryResourceSpec}), which
 * `serveCollection` (network/live) compiles through here. Each kind holds only
 * its own fields — a point spec cannot spell an order, a row key or a family
 * (tsc) — and `windowQueryResource`'s overloads pair each with its descriptor.
 * There is deliberately NO `limit` / `recompute` / `scopedMembership` here:
 * the bound comes from the subscription params (clamped to `maxLimit`), and
 * membership is always incremental. Nor `edges`: the compiled resource is
 * ROUTED (its routes name the table it reads), and a routed entry takes no
 * cascade — it routes the tables it reads itself.
 */
export type BoundedQueryResourceSpec<
  P extends ResourceParams = ResourceParams,
> = WindowQueryResourceSpec<P> | PointQueryResourceSpec<P>;

/** What both kinds of a bounded spec read: the relation set, its projection and its scope. */
interface BoundedSpecBase<P extends ResourceParams> {
  /** The table to read: a base table, or an entity. Never a view (see `RoutedSource`). */
  from: RoutedSource;
  /**
   * The relations joined onto `from` (see `JoinSpec`, `core/`). Each is read by
   * exactly the tuples whose SQL references it — projected, a required (INNER)
   * lookup, or named by the tuple's `where` / order — and is routed by the
   * route its kind maps to (`./joins`). A projection over joins must be
   * explicit (`select`), each joined column rendered against its alias.
   */
  joins?: readonly JoinSpec[];
  /**
   * Overrides the derived pk (the table's single primary). For `point`,
   * `point.by` IS the identity pk. A pk that is not the table's primary key
   * routes by that column's value, which the change feed does not carry yet —
   * its readers recompute FULL on every change.
   */
  identity?: { pk: PgColumn };
  /**
   * Projection. Default: an entity's `wireColumns`, or all of the table's columns.
   * Required with `joins`: a joined column is projected rendered against its
   * alias (`JoinPlan.render`).
   */
  select?: SelectMap;
  /**
   * Server-fixed scope predicate (e.g. `dismissed = false`). A mutable-column
   * `where` is FINE: a where-flip is detected as a membership exit/entry by the
   * runtime's window path.
   */
  where?: SQL | ((params: P) => SQL | undefined);
  /**
   * Every column a per-params `where` may read — rendered columns (as in
   * `select`), or fragments standing for them (a static predicate the function
   * ANDs in) — the universe its routes' `columns` are cut from. Each tuple's
   * `where` is checked against it (a column outside throws). Absent with a
   * function `where`, every column of every relation is a route column:
   * correct, but the `unchanged` gate then never skips.
   */
  whereReads?: readonly (PgColumn | SQL)[];
  /**
   * The wire row, derived IN JS from each selected row — every row a loader
   * returns (full, scoped refill and point) goes through it, so the order
   * signature reads the encoded row too. For a column whose stored form cannot
   * cross the JSON wire as is (a `bytea`: sql-column's `withWire`); never done
   * in SQL, where `encode(…, 'base64')` folds lines at 76 chars.
   */
  encodeRow?: (row: Record<string, unknown>) => Record<string, unknown>;
  /** Fixed-window trailing debounce (ms) for this resource's flushes. */
  debounceMs?: number;
  /** Test seam. Defaults to the real per-worktree drizzle `db`. */
  db?: QueryDb;
}

/**
 * The window kind: an ordered, bounded window whose every tuple may be one
 * key-range page of a paged read (`rowKey`).
 */
export interface WindowQueryResourceSpec<
  P extends ResourceParams = ResourceParams,
> extends BoundedSpecBase<P> {
  /**
   * Join FAMILIES (see `JoinFamily`, `core/`): side tables joined once per
   * MEMBER a tuple's `where` / order names — a DataView surface's custom
   * columns. The caller renders a member's value through its own plan
   * (`JoinPlan.readMember`, over these same family objects); this compiler joins
   * exactly the members a tuple's SQL references, emits ONE route per family,
   * and reads it as `membership` with a `match` on the members that tuple reads.
   * A member a tuple orders by is projected under `valuesKey` (an object keyed
   * by the member's join alias) so the tuple's order signature sees it move.
   */
  families?: { joins: readonly JoinFamily[]; valuesKey: string };
  /**
   * External upstream tuples whose change moves this compile's vocabulary (the
   * members a family may name, how their values cast): passed to the runtime as
   * the routed entry's `recomputeOn` — every subscribed tuple recomputes FULL
   * and its read-set memo is dropped.
   */
  recomputeOn?: ReadonlyArray<RoutedRecomputeOn>;
  /**
   * The window's total order. Static keys, or a per-params resolver
   * (`(params) => WindowOrderKey[]`, like `where`) for a client-chosen sort: the
   * compiler resolves it per subscription tuple and memoizes the rendered
   * ORDER BY per canonical order (column name + dir + nullable). Either way the
   * pk tiebreaker and NULLS LAST are appended. A resolver REQUIRES
   * `signatureColumns`.
   */
  orderBy:
    WindowOrderKey | WindowOrderKey[] | ((params: P) => WindowOrderKey[]);
  /**
   * Every column a tuple's order may read — REQUIRED with a function
   * `orderBy` (the union of every column it may sort by), optional with a
   * static one (default: the declared order columns). Each tuple's order
   * signature covers the columns IT orders by, cut from this set: an UPDATE
   * to one of them re-derives that tuple's window (one bounded ids query),
   * while a tuple sorting by another column keeps its in-place path. Every
   * column must be projected, and a resolved order column outside this set
   * throws — its reorder would otherwise go stale.
   */
  signatureColumns?: (PgColumn | SQL)[];
  /**
   * `maxLimit` clamps every subscription's decoded `limit` (the loader AND
   * `windowIdsOf`, identically). It may instead come from the descriptor
   * (`contract.window.maxLimit`); when both are given they must be equal, and
   * at least one is required. The default limit lives ONLY on the descriptor
   * (the `liveCollection`'s `default.limit`) — the single source both the
   * client read and the boot path use; the compiler asserts
   * `defaultLimit <= maxLimit` at module eval.
   */
  window: {
    maxLimit?: number;
    /**
     * The subscription's decoded limit, when the descriptor's codec cannot
     * decode the params alone (a contributed collection decodes against the
     * column sets it serves). Default: the descriptor codec's `decode`.
     * Clamped to `maxLimit` either way.
     */
    limitOf?: (params: P) => number;
    /**
     * The params gate, for the same reason: the descriptor's codec would
     * refuse the column names a contributed collection serves. Replaces the
     * descriptor's `validateParams` on the server (the runtime's
     * `ServerResourceOptions.validateParams`); throws `ResourceContractError`
     * on a mismatch — of the RAW params (it is the gate that decides whether
     * they are a `P`). Default: the descriptor's.
     */
    validateParams?: (params: ResourceParams) => void;
  };
  /**
   * How a projected field is read off an ENCODED row — what the order
   * signature reads. Default `row[field]`; an `encodeRow` that moves a field
   * (a collection folding contributed columns into `$columns`) says where it
   * went.
   */
  readField?: (row: Record<string, unknown>, field: string) => unknown;
  /**
   * Every tuple may be one key-range PAGE of a paged read — its order cut by
   * an exclusive `after` and an inclusive `until` row key — and every full /
   * scoped row carries its own row key in `keyField`, so a client can cut the
   * order at a row without re-deriving it.
   *
   * A row key is the canonical JSON array of the tuple's order keys (the
   * declared ones, then the pk unless one already is) as exact Postgres text
   * (`col::text`): a key a decoded row would have rounded (a µs `timestamptz`
   * read as a ms `Date`) crosses exactly. A key over `maxKeyBytes` is `null` —
   * a cut rides in every tuple's params, so it stays bounded. Cuts compile on
   * the ORDER side (over the tuple's rendered order keys, each operand cast
   * back to its column's type), never through `where`: they read only order
   * columns, which the routes and the per-tuple signature already cover.
   */
  rowKey: {
    /** The tuple's cuts, each exactly one value per order key (the codec checked it). */
    cutsOf: (params: P) => {
      after?: readonly (string | null)[];
      until?: readonly (string | null)[];
    };
    /**
     * The tuple's page family: one canonical string for exactly the tuples
     * of ONE query (filter and order), whatever their cuts and limit — the
     * runtime derives a page only from pages of its family (the membership's
     * `familyOf`, see resource-runtime's *Seeded derivation*).
     */
    familyOf: (params: P) => string;
    /** The wire field the row key is projected under. */
    keyField: string;
    /** A row key's JSON over this many bytes is projected as `null`. */
    maxKeyBytes: number;
  };
  point?: never;
}

/**
 * The point-set kind: an explicit id set, unordered (entrants append) — so
 * nothing to order, sign, cut or key, and no `where` / order to name a family
 * member: every window-only field is `never`.
 */
export interface PointQueryResourceSpec<
  P extends ResourceParams = ResourceParams,
> extends BoundedSpecBase<P> {
  /**
   * `by` is the column the subscribed id set matches — it IS the resource's
   * identity pk (the change-feed routes by intersecting changed identity ids
   * with each tuple's set, so any other column could never intersect).
   * Redundant `identity.pk`, if given, must equal it.
   */
  point: { by: PgColumn };
  window?: never;
  orderBy?: never;
  signatureColumns?: never;
  families?: never;
  recomputeOn?: never;
  readField?: never;
  rowKey?: never;
}
