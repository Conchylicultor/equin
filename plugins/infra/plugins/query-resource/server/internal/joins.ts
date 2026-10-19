import { utf8ByteLength } from "./utf8";
import {
  and,
  Column,
  eq,
  getTableColumns,
  getTableName,
  is,
  Name,
  Param,
  Placeholder,
  sql,
  SQL,
  StringChunk,
  Subquery,
  Table,
  View,
  type SQLWrapper,
} from "drizzle-orm";
import {
  alias as aliasTable,
  getTableConfig,
  PgDialect,
  type PgColumn,
  type PgTable,
} from "drizzle-orm/pg-core";
import type { CompiledRollupSource } from "@plugins/database/plugins/derived-tables/core";
import type { DerivedRead } from "@plugins/framework/plugins/resource-runtime/core";
import {
  BASE_RELATION,
  expr as exprField,
  familyMember,
  type ColumnRef,
  type ExprField,
  type ExtensionJoin,
  type JoinFamily,
  type JoinSpec,
  type KeyedSideJoin,
  type RollupJoin,
} from "@plugins/infra/plugins/query-resource/core";
import { SQL_TYPE_RE, type ExprDecoder } from "../../core/internal/expr";
import { anyOf, type InvalidIdPolicy } from "./raw-sql";
import {
  tablePrimary,
  type RawHostMap,
  type RawRoute,
  type RoutedBase,
} from "./routes";
import type { QueryDb, QueryStep, SelectMap } from "./spec";

// The server half of the join vocabulary (`core/internal/joins.ts`): renders a
// compile's declared joins, checks them (A4 of
// research/2026-09-29-global-scoped-change-routing.md), and answers the one
// question every routed shape asks of a SQL fragment — WHICH relations does it
// read? That answer is read off the rendered drizzle SQL itself (the columns
// and tables it embeds), never declared beside it, so a tuple's read-set and
// the SQL it runs cannot disagree:
//
// - a join's columns render against its ALIAS (`"playback"."last_played_at"`),
//   the base table's against its own name, so every column chunk names its
//   relation;
// - a relation the fragment reads that is neither the base nor a declared join
//   throws — a table a routed compile reads must be one it routes (the runtime's
//   drift guard, A8, catches only what a load actually captured).
//
// Raw SQL text (`sql.raw`) carries no column objects and is invisible here; a
// routed compile's SQL is built from drizzle columns. The one exception is an
// AGGREGATE (`JoinPlan.renderAggregate`): a grouped value a raw shape reads off
// a CTE or a rollup by name, whose provenance — the relation columns it is
// computed from — is declared when it is rendered, and read from there.

/**
 * A column as a compiled query reads it: a column of the base or of a join's
 * alias — or, for an EXTENSION column with a literal default,
 * `COALESCE("alias"."col", <default>)`. An extension row that does not exist
 * means its declared defaults (entity-extensions' semantics), so a host with no
 * side row reads the default — in a filter, a sort and a projection alike —
 * never a NULL the extension would never have stored. Provenance is unchanged:
 * the expression still names the alias column.
 */
export type ReadColumn = PgColumn | SQL;

/**
 * What a read EXPRESSION a plan rendered is:
 *
 * - `column` — an expression standing for ONE alias column: a defaulted
 *   extension column's COALESCE (never NULL, the column's own type), or a
 *   family member's cast value (NULL for a host with no member row, the cast's
 *   type). It still IS that column for provenance (`columnOf`).
 * - `expr` — an `ExprField` rendered over `j` (`JoinPlan.renderExpr`): it
 *   reads any number of columns (read off its SQL, `columnsIn`), so it has no
 *   one column — `columnOf` / `relationOf` throw on it — but a name, a declared
 *   nullability and an SQL type.
 * - `aggregate` — a grouped value (`JoinPlan.renderAggregate`) whose SQL
 *   names a CTE or rollup output, so it carries no relation column of its
 *   own: its provenance is `reads`, the rendered columns it is computed from,
 *   and `columnsIn` descends into them in place of its SQL. Like an
 *   expression it reads no one column (`columnOf` / `relationOf` throw); its
 *   `relation` is the join (or the base) it belongs to.
 */
type ReadExpression =
  | { kind: "column"; col: PgColumn; nullable: boolean; sqlType: string }
  | { kind: "expr"; name: string; nullable: boolean; sqlType: string }
  | {
      kind: "aggregate";
      name: string;
      relation: string;
      reads: readonly ReadColumn[];
      nullable: boolean;
      sqlType: string;
    };

/**
 * Every read expression a plan rendered → what it is (`ReadExpression`), keyed
 * by the SQL object's identity. Module-level, not per plan: a compile renders
 * its columns through one plan and hands them to another (`serveCollection` →
 * `compileWindowQuery`), which must still know what each expression reads.
 */
const readExpressions = new WeakMap<SQL, ReadExpression>();

/**
 * Each family's members by alias, as any plan rendered them — module-level for
 * the same reason as `readExpressions`: the plan that applies a tuple's joins
 * finds a member another plan rendered by its alias.
 */
const familyAliases = new WeakMap<JoinFamily, Map<string, string>>();

/** How a family member's value is read: a cast of the raw column, and the SQL type it produces. */
export interface MemberRead {
  cast: (value: PgColumn) => SQL;
  sqlType: string;
}

/**
 * A join a `JoinPlan` renders row-wise: a window join (`JoinSpec`), or — for
 * the `all` compiler only (`compileAllJoins`) — a rollup, LEFT-joined on its
 * key like an N:1 lookup but routed through its SOURCES (`joinRoutes`).
 */
export type PlannedJoin = JoinSpec | RollupJoin;

/** The join kinds only a collection declared `all` reads (`AllJoinSpec` minus `JoinSpec`). */
const ALL_ONLY_KINDS: ReadonlySet<string> = new Set([
  "rollup",
  "children",
  "closure",
]);

/** The kinds a `JoinPlan` joins row-wise (`PlannedJoin`'s). */
const PLANNED_KINDS: ReadonlySet<string> = new Set([
  "extension",
  "lookup",
  "keyed-side",
  "rollup",
]);

/** One declared join, rendered. */
export interface CompiledJoin {
  spec: PlannedJoin;
  alias: string;
  /**
   * The joined table, unaliased: a window join's `table`, a rollup's
   * `rollup.handle` (never declared beside the rollup — see `RollupJoin`).
   */
  table: PgTable;
  /** The joined table under its alias: what the SQL joins. */
  rendered: PgTable;
  /** INNER (a required lookup) — a missing joined row drops the host row. */
  inner: boolean;
  /** The join this one hangs off (a chained lookup); `null` = the base table. */
  parent: string | null;
  /** The rendered join condition. */
  on: SQL;
}

/** A relation ("base" or a join alias) and a column of it, by DB name. */
export type RelationColumn = readonly [relation: string, column: string];

export interface JoinPlan {
  /** The base table's SQL name — how its columns render. */
  readonly baseName: string;
  readonly joins: readonly CompiledJoin[];
  /** The INNER joins: every tuple reads them, as membership. */
  readonly required: ReadonlySet<string>;
  /** Render a `ColumnRef` as the column the SQL reads (A4-checked) — see `ReadColumn`. */
  render(ref: ColumnRef): ReadColumn;
  /**
   * Every relation's columns, rendered against their relation (`JoinColumns`):
   * what a static predicate over the joins is written with. These are the raw
   * columns — a predicate over a defaulted extension column states its own
   * NULL handling.
   */
  columns(): Readonly<Record<string, Readonly<Record<string, PgColumn>>>>;
  /**
   * The relation a rendered column belongs to; throws for an undeclared one,
   * and for an `ExprField` (it reads no one relation — see `relationsIn`).
   */
  relationOf(col: ReadColumn): string;
  /**
   * The column a rendered one reads: itself, or the alias column a defaulted
   * one coalesces. Throws for an `ExprField`, which reads no one column.
   */
  columnOf(col: ReadColumn): PgColumn;
  /**
   * Whether a rendered read stands for no one column — an `ExprField`
   * (`renderExpr`) or an aggregate (`renderAggregate`) — so `columnOf` /
   * `relationOf` would throw on it and its relations are `relationsIn`'s.
   */
  isComputed(col: ReadColumn): boolean;
  /** A read's name, for keys and messages: its column's DB name, or an expression's field name. */
  nameOf(col: ReadColumn): string;
  /** The family member's join alias a read is, or `undefined` (any other column, or an expression). */
  memberOf(col: ReadColumn): string | undefined;
  /**
   * What a read is keyed by in a memo of renderings: its relation, or — for an
   * `ExprField` — `expr:<name>` (its identity is the SQL object's).
   */
  relationKey(col: ReadColumn): string;
  /**
   * Render an `ExprField` — its SQL over the binding's `j` (refs rendering
   * this plan's DEFAULTED wire columns) — once per plan: the same SQL object
   * every time, which every other plan recognises by identity. Throws on an
   * expression that is exactly one column (bind a column override), reads a
   * column that is neither a wire column of its relation nor a declared
   * `serverOnly` base column (`baseColumns`: the base source's wire columns),
   * or reads a relation that is neither the base nor a declared join.
   */
  renderExpr(
    field: ExprField,
    opts: { name: string; baseColumns: Readonly<Record<string, PgColumn>> },
  ): SQL;
  /**
   * Register an AGGREGATE: a grouped value whose SQL (`sql`) reads a CTE's or
   * a rollup's output by name, which no column walk can see. Its provenance is
   * declared instead — `reads`, the columns it is computed from, rendered
   * through this plan — and every walk (`columnsIn`, so a tuple's routes and
   * gates, and an expression over it) descends into `reads` in place of its
   * SQL. Returns `(<sql>)`, decoded by `decoder`, registered by identity like
   * an expression: `canBeNull` is `nullable` — or true through a LEFT join
   * over `relation` (`outer`) — `sqlTypeOf` its `sqlType`, `nameOf` its
   * `name`, and `isComputed` holds.
   *
   * Rendered once per plan per (`relation`, `name`), like `renderExpr` per
   * field: a second call returns the SAME object (its identity is what memos
   * of renderings key on), and throws if its SQL, `reads` (by identity),
   * `nullable`, `sqlType` or `decoder` differ from the first's.
   *
   * Throws on an `sqlType` outside `SQL_TYPE_RE`, a `relation` that is neither
   * the base nor a declared join, a relation `reads` names that is neither,
   * and on `reads` that resolve to no relation column at all — a value no route
   * could reach, so a change to what it aggregates would leave it silently
   * stale (C7 of research/2026-10-06-global-scoped-change-routing-p8-v3.md).
   */
  renderAggregate(
    sql: SQL,
    opts: {
      name: string;
      relation: string;
      reads: readonly ReadColumn[];
      nullable: boolean;
      sqlType: string;
      decoder: ExprDecoder;
    },
  ): SQL;
  /**
   * Whether a rendered column can read NULL: a nullable column, or one a LEFT
   * join (its own or an ancestor's) may leave NULL — never a defaulted
   * extension column, which reads its default instead. An expression answers
   * its declared nullability; an aggregate its declared one, or true when its
   * `relation` sits behind a LEFT join — and throws, naming the aggregate,
   * when that relation is not one this plan declares (an aggregate another
   * plan registered).
   */
  canBeNull(col: ReadColumn): boolean;
  /**
   * Every (relation, column) a SQL fragment, a column, or a projection reads.
   * An aggregate is read through its declared `reads`; with `{ direct: true }`
   * it is skipped instead — what the fragment reads OUTSIDE every aggregate.
   */
  columnsIn(fragment: unknown, opts?: { direct?: boolean }): RelationColumn[];
  /**
   * Whether a relation is a GROUPED one (the `all` compiler's children /
   * closure internals — `compileAllJoins`' `grouped`): read only through the
   * aggregates its grouped CTE computes, never joined row-wise.
   */
  isGrouped(relation: string): boolean;
  /** The relations a fragment reads (see `columnsIn`), the base included. */
  relationsIn(fragment: unknown): Set<string>;
  /** The joins among `seeds`, plus every join they hang off. */
  closure(seeds: Iterable<string>): Set<string>;
  /** Whether a relation's columns may read NULL through a LEFT join (its own or an ancestor's). */
  outer(relation: string): boolean;
  /** Apply the `included` joins to a query, in declaration order (family members after, by alias). */
  apply<Row>(q: QueryStep<Row>, included: ReadonlySet<string>): QueryStep<Row>;
  /** Every (relation, column) the join conditions read. */
  readonly conditionColumns: readonly RelationColumn[];
  /**
   * The ids of the routes a declared join is reached by (`joinRoutes`) — what
   * a tuple reading the join names in its `usesOf`: the alias itself for a
   * window join; one `<alias>[<source>]` per source for a rollup, which no
   * route may name (A1). Throws for an alias no declared join has.
   */
  routeIdsOf(alias: string): readonly string[];
  /**
   * The derived tables the joins read beside their route tables (a rollup's
   * table, with the sources its routes name) — the plan's
   * `RoutePlanInput.derivedReads`. Empty unless a rollup is joined.
   */
  readonly derivedReads: readonly DerivedRead[];
  /** The join families this plan may render members of. */
  readonly families: readonly JoinFamily[];
  /**
   * A family member's value, rendered against the member's alias (its join is
   * compiled on first use): the raw column, or `read`'s cast of it — an
   * expression that reads NULL for a host with no member row.
   */
  readMember(familyId: string, member: string, read?: MemberRead): ReadColumn;
  /** The family and member a relation is, when it is a family member's alias. */
  familyOf(
    relation: string,
  ): { family: JoinFamily; member: string } | undefined;
  /** The SQL type a rendered column reads as (a cast expression's own). */
  sqlTypeOf(col: ReadColumn): string;
}

/**
 * The `j` of a field binding: `j.base.x` over `baseColumns` (the base source's
 * wire columns), `j.<alias>.x` over each join's wire columns (`wireColumns`,
 * else every column of its table) — one `ColumnRef` per column, so a
 * server-only column is not offered. A column override returns one;
 * `compileJoins` checks what it names when it renders it.
 *
 * Each ref is also a SQL fragment (`TypedColumnRef`): interpolated into an
 * `ExprField`'s SQL it renders through `render` — the plan's defaulted wire
 * column. `render` is called only when a query is built or walked, so the
 * plan it names may be compiled after the refs (a binding's id resolves first).
 */
export function joinRefs(
  baseColumns: Readonly<Record<string, PgColumn>>,
  specs: readonly JoinSpec[],
  render: (ref: ColumnRef) => ReadColumn,
): Readonly<Record<string, Readonly<Record<string, ColumnRef>>>> {
  const refsOf = (from: string, columns: Readonly<Record<string, PgColumn>>) =>
    Object.fromEntries(
      Object.entries(columns).map(([k, col]) => {
        const ref = { from, col };
        return [
          k,
          {
            ...ref,
            getSQL: (): SQL => {
              const rendered = render(ref);
              return is(rendered, SQL) ? rendered : sql`${rendered}`;
            },
            // A column reads as itself: no parentheses around it.
            shouldOmitSQLParens: () => true,
          } satisfies ColumnRef & SQLWrapper,
        ];
      }),
    );
  return {
    [BASE_RELATION]: refsOf(BASE_RELATION, baseColumns),
    ...Object.fromEntries(
      specs.map((j) => [
        j.alias,
        refsOf(
          j.alias,
          j.wireColumns ??
            (getTableColumns(j.table) as Record<string, PgColumn>),
        ),
      ]),
    ),
  };
}

// drizzle marks an aliased table with this registered symbol (`alias()`); its
// typings do not expose `Table.Symbol`, so it is read by its registered name.
const IS_ALIAS = Symbol.for("drizzle:IsAlias");

/** Whether a column is rendered against a join's alias (not a base / plain table column). */
function isJoinedColumn(col: Column): boolean {
  return (col.table as unknown as Record<symbol, unknown>)[IS_ALIAS] === true;
}

/** Whether two rendered columns are the same column of the same relation (a defaulted one: the same expression). */
export function sameColumn(a: ReadColumn, b: ReadColumn): boolean {
  if (a === b) return true;
  if (is(a, SQL) || is(b, SQL)) return false;
  const x = a as PgColumn;
  const y = b as PgColumn;
  return x.name === y.name && getTableName(x.table) === getTableName(y.table);
}

/**
 * An extension column's literal default (a number, boolean or string its
 * meta declares — drizzle's `.default(value)`), or `undefined`: none, or a
 * computed one (`defaultNow()`, SQL) that no reader can stand in for.
 */
function literalDefault(col: PgColumn): string | number | boolean | undefined {
  if (!col.hasDefault) return undefined;
  const value: unknown = col.default;
  return typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "string"
    ? value
    : undefined;
}

/**
 * What an extension column reads where the side row is missing, as the
 * COALESCE's second operand — or `undefined` (read the raw column: NULL for a
 * missing row).
 *
 * - A declared `absent` (an exposing extension's, derived from the field's
 *   declared default) wins: `null` reads NULL; a literal is bound PLAIN
 *   (`sql.param(value)`), the value the field itself declares.
 * - Else the column's literal DB default, bound through the column (unchanged).
 */
function missingRowRead(
  spec: ExtensionJoin,
  key: string,
  col: PgColumn,
): SQL | undefined {
  if (spec.absent !== undefined && Object.hasOwn(spec.absent, key)) {
    const value = spec.absent[key]!;
    return value === null ? undefined : sql`${sql.param(value)}`;
  }
  const fallback = literalDefault(col);
  return fallback === undefined ? undefined : sql`${sql.param(fallback, col)}`;
}

/**
 * A field read off an extension's side-row EXISTENCE (`spec.presence[id]`) as
 * an expression over the join's key ref (`keyRef` — `j.<alias>.<key>`, which
 * renders as the raw stored key): `<key> IS NOT NULL`, a never-NULL boolean,
 * or `CASE WHEN <key> IS NOT NULL THEN <present> ELSE <absent> END`, a
 * never-NULL text (the plan's `renderExpr` parenthesizes either). Bound like any expression field, so it projects, filters,
 * sorts and groups on the server; its provenance is the key column (a side
 * row's insert or delete moves it). Throws on an id the join declares no
 * presence for.
 */
export function presenceExpr(
  spec: ExtensionJoin,
  id: string,
  keyRef: SQLWrapper,
): ExprField<boolean> | ExprField<string> {
  const presence =
    spec.presence !== undefined && Object.hasOwn(spec.presence, id)
      ? spec.presence[id]!
      : undefined;
  if (presence === undefined) {
    throw new Error(
      `presenceExpr("${spec.alias}", "${id}"): the join declares no presence field "${id}".`,
    );
  }
  if (presence.values === null) {
    return exprField(sql`${keyRef} IS NOT NULL`, {
      decoder: Boolean,
      sqlType: "boolean",
      notNull: true,
    });
  }
  const { present, absent } = presence.values;
  return exprField(
    sql`CASE WHEN ${keyRef} IS NOT NULL THEN ${present}::text ELSE ${absent}::text END`,
    { decoder: String, sqlType: "text", notNull: true },
  );
}

/**
 * The key of `select` projecting `col` (same relation, same column), or
 * undefined. A join column never matches a base column of the same name.
 */
export function projectedField(
  select: SelectMap,
  col: ReadColumn,
): string | undefined {
  for (const [key, value] of Object.entries(select)) {
    if (value === col) return key;
    if (is(value, Column) && sameColumn(value as PgColumn, col)) return key;
  }
  return undefined;
}

/**
 * Render and check a compile's joins. `hostPk` is the compiled resource's
 * identity column (a keyed window / point), or undefined for a non-keyed
 * grouping — whose routes are all `full`, so no join maps to host ids.
 * Every misuse throws here, at module eval.
 *
 * A window, a `:rows` point read, a `:groups` grouping and a union arm read
 * `JoinSpec` only (C9 / D24 / A24 of
 * research/2026-10-06-global-scoped-change-routing-p8-v3.md). A rollup,
 * children or closure join — `AllJoinSpec`'s own kinds — is a tsc error here,
 * and refused at runtime for a caller a cast let through: a grouping would mint
 * a `full` route naming the rollup table (A1 would refuse it at boot), and a
 * children / closure join has no row-wise rendering at all.
 */
export function compileJoins(
  base: RoutedBase,
  specs: readonly JoinSpec[],
  hostPk: PgColumn | undefined,
  label: string,
  families: readonly JoinFamily[] = [],
): JoinPlan {
  for (const spec of specs as readonly { kind: string; alias: string }[]) {
    if (ALL_ONLY_KINDS.has(spec.kind)) {
      throw new Error(
        `${label}: join "${spec.alias}" is a ${spec.kind} join, which only a collection declared \`all\` reads — a window, a :rows point read, a :groups grouping and a union arm take window joins (extension / lookup / keyed-side). Declare the collection with \`all\`, or read the table through a lookup (C9 / D24).`,
      );
    }
  }
  return compilePlan(base, specs, hostPk, label, families);
}

/**
 * The `all` compiler's joins: the window kinds plus a top-level `rollup`
 * (LEFT on the rollup's key, `on` a base column — its pk or any other — or an
 * earlier join's, of the key's SQL type). A rollup's routes are its SOURCES'
 * (`joinRoutes`), and its table is a derived read (`JoinPlan.derivedReads`).
 * Keyed by `hostPk`, the collection's identity.
 */
export function compileAllJoins(
  base: RoutedBase,
  specs: readonly PlannedJoin[],
  hostPk: PgColumn,
  label: string,
  grouped: ReadonlyMap<string, PgTable> = new Map(),
): JoinPlan {
  return compilePlan(base, specs, hostPk, label, [], grouped);
}

/**
 * A35: a rollup source's `via` hop is read at statement time by the maintain
 * function, and again after commit by the source route's reverse probe. A
 * write that moves or removes a hop row (`UPDATE attempts SET task_id`, an RI
 * cascade deleting it) re-keys rollup rows the hop alone cannot name
 * afterwards. Only a source ON the hop table re-aggregates (and routes) the old
 * and the new keys, and only when it sees every such write:
 *
 * - its `carry` is the hop's `key` (and it has no `via` of its own), so the old
 *   and new keys are what it carries;
 * - the hop's `match` is in its pk ∪ carry ∪ reads, so a re-match (`UPDATE …
 *   SET attempt_id`) passes both the maintain function's diff and the route's
 *   column gate;
 * - its `ops` include `update` and `delete`, the two statements that re-key.
 *
 * `refuse` is called with the first thing a hop is missing, and must throw. Takes the compiled sources (not a `JoinSpec`) so every compile that
 * reads a rollup — and, once every production rollup satisfies it,
 * `defineRollup` itself — can run the one check.
 */
export function assertHopsCovered(
  sources: readonly CompiledRollupSource[],
  refuse: (problem: string) => never,
): void {
  for (const src of sources) {
    const via = src.via;
    if (via === undefined) continue;
    const hop = sources.find((s) => s.table === via.table);
    const add = `Add "${via.table}" as a source with \`carry: ${via.table}.${via.key}\``;
    const head = `source "${src.table}" is resolved through the hop table "${via.table}"`;
    if (hop === undefined) {
      return refuse(
        `${head}, which is not a source of the rollup — a write that moves or deletes a "${via.table}" row would re-key rollup rows no route reaches. ${add}`,
      );
    }
    if (hop.carry !== via.key || hop.via !== undefined) {
      refuse(
        `${head}, whose source does not carry the hop key "${via.key}" directly — a write that moves a "${via.table}" row would re-aggregate neither its old nor its new key. Set its \`carry: ${via.table}.${via.key}\` with no \`via\``,
      );
    }
    if (
      !hop.pk.includes(via.match) &&
      hop.carry !== via.match &&
      !hop.reads.includes(via.match)
    ) {
      refuse(
        `${head}, whose source neither keys on nor reads the hop match "${via.match}" — an UPDATE of "${via.table}.${via.match}" would pass the maintain function's diff and the route's column gate unseen. Add "${via.table}.${via.match}" to its \`reads\``,
      );
    }
    const missing = (["update", "delete"] as const).filter(
      (op) => !hop.ops.includes(op),
    );
    if (missing.length > 0) {
      refuse(
        `${head}, whose source fires on no ${missing.map((op) => `"${op}"`).join(" or ")} — a statement that re-keys a "${via.table}" row would get no trigger. Add ${missing.map((op) => `"${op}"`).join(" and ")} to its \`ops\` (or drop \`ops\` for all three)`,
      );
    }
  }
}

/**
 * `grouped`: the `all` compiler's GROUPED relations (`./grouped`) — each
 * internal relation of a children or closure join (`<a>`, `<a>__<r>`,
 * `<a>__anc`, …), by name, with the table it is that table aliased as. They
 * are not joined row-wise: a column of one is read only inside an aggregate
 * (whose provenance names it), so this plan resolves such a column to its
 * relation, never walks it as a join, and reads none of them through a LEFT
 * join of its own (the grouped CTE's `ifNone` is what a host with no group
 * row reads).
 */
function compilePlan(
  base: RoutedBase,
  specs: readonly PlannedJoin[],
  hostPk: PgColumn | undefined,
  label: string,
  families: readonly JoinFamily[],
  grouped: ReadonlyMap<string, PgTable> = new Map(),
): JoinPlan {
  const fail = (message: string): never => {
    throw new Error(`${label}: ${message}`);
  };
  const baseName = base.name;
  const byAlias = new Map<string, CompiledJoin>();
  const joins: CompiledJoin[] = [];
  // Rendered columns, one object per (relation, column): drizzle's alias proxy
  // mints a fresh column on every property read.
  const renderedCache = new Map<string, PgColumn>();
  // A defaulted extension column's COALESCE, one object per (relation,
  // column) too (the alias column it reads: `readExpressions`).
  const defaultedCache = new Map<string, SQL>();
  const renderRaw = (join: CompiledJoin, key: string): PgColumn => {
    const cacheKey = `${join.alias}\u0000${key}`;
    let col = renderedCache.get(cacheKey);
    if (col === undefined) {
      col = (join.rendered as unknown as Record<string, PgColumn>)[key]!;
      renderedCache.set(cacheKey, col);
    }
    return col;
  };

  const keyOf = (table: PgTable, col: PgColumn): string | undefined =>
    Object.entries(getTableColumns(table) as Record<string, PgColumn>).find(
      ([, c]) => c === col,
    )?.[0];

  const render = (ref: ColumnRef): ReadColumn => {
    if (ref.from === BASE_RELATION) {
      if (ref.col.table !== base.table) {
        fail(
          `column "${ref.col.name}" is not a column of the base table "${baseName}" — a base ColumnRef names the base table's own column (A4).`,
        );
      }
      return ref.col;
    }
    const join = byAlias.get(ref.from);
    if (join === undefined) {
      return fail(
        `ColumnRef names relation "${ref.from}", which is neither the base nor a join declared before it — declare the join (A4).`,
      );
    }
    const key = keyOf(join.table, ref.col);
    if (key === undefined) {
      return fail(
        `column "${ref.col.name}" is not a column of join "${ref.from}" (table "${getTableName(join.table)}") (A4).`,
      );
    }
    const col = renderRaw(join, key);
    const fallback =
      join.spec.kind === "extension"
        ? missingRowRead(join.spec, key, ref.col)
        : undefined;
    if (fallback === undefined) return col;
    const cacheKey = `${ref.from}\u0000${key}`;
    let expr = defaultedCache.get(cacheKey);
    if (expr === undefined) {
      expr = sql`COALESCE(${col}, ${fallback})`.mapWith(col);
      defaultedCache.set(cacheKey, expr);
      readExpressions.set(expr, {
        kind: "column",
        col,
        nullable: false,
        sqlType: col.getSQLType(),
      });
    }
    return expr;
  };

  // A join condition compares stored keys: the raw column, never a default.
  const rawRender = (ref: ColumnRef): PgColumn => columnOf(render(ref));

  const expressionOf = (col: SQL): ReadExpression => {
    const known = readExpressions.get(col);
    if (known === undefined) {
      return fail(
        "a SQL expression is not one of this compile's rendered columns — render a ColumnRef (or an ExprField, or an aggregate) through the plan.",
      );
    }
    return known;
  };

  function columnOf(col: ReadColumn): PgColumn {
    if (!is(col, SQL)) return col;
    const known = expressionOf(col);
    if (known.kind === "expr") {
      return fail(
        `expression field "${known.name}" reads no single column — read its relations off its SQL (relationsIn), not one column.`,
      );
    }
    if (known.kind === "aggregate") {
      return fail(
        `aggregate "${known.name}" (of relation "${known.relation}") reads no single column — read its relations off its declared reads (relationsIn), not one column.`,
      );
    }
    return known.col;
  }

  // An expression or an aggregate: a read that stands for no one column.
  const isComputed = (col: ReadColumn): boolean =>
    is(col, SQL) && expressionOf(col).kind !== "column";

  const primaryOf = (table: PgTable): PgColumn | null => tablePrimary(table);

  const hostCol = (): PgColumn =>
    hostPk ??
    fail(
      "a keyed-side join matches the host's identity, and this compile has none.",
    );

  for (const spec of specs) {
    const { alias } = spec;
    if (alias === BASE_RELATION || alias === baseName) {
      fail(
        `join alias "${alias}" is reserved — it names the base table. Pick another.`,
      );
    }
    if (byAlias.has(alias)) fail(`duplicate join alias "${alias}".`);
    // Before anything reads the spec's table: a children / closure join (a
    // cast let through) has none to alias.
    const kind = (spec as { kind: string }).kind;
    if (!PLANNED_KINDS.has(kind)) {
      fail(
        `join "${alias}" is a ${kind} join, which a JoinPlan does not join row-wise — ${ALL_ONLY_KINDS.has(kind) ? "a children or closure join is rendered as a grouped CTE by the `all` compiler" : "an unknown join kind"}.`,
      );
    }
    const table = spec.kind === "rollup" ? spec.rollup.handle : spec.table;
    const rendered = aliasTable(table, alias) as PgTable;
    const pending: CompiledJoin = {
      spec,
      alias,
      table,
      rendered,
      inner: spec.kind === "lookup" && spec.required,
      parent: null,
      on: undefined as unknown as SQL,
    };
    // Registered before its condition renders, so the join's own columns
    // resolve; `on` of a lookup may only name an EARLIER relation (checked
    // below).
    byAlias.set(alias, pending);
    const own = (col: PgColumn, role: string): PgColumn => {
      const key = keyOf(table, col);
      if (key === undefined) {
        return fail(
          `join "${alias}": its ${role} "${col.name}" is not a column of table "${getTableName(table)}" (A4).`,
        );
      }
      return renderRaw(pending, key);
    };
    switch (spec.kind) {
      case "extension": {
        if (spec.on !== undefined) {
          // A RELATED host's extension: keyed on a column of the base or an
          // earlier join, checked like a lookup's `on`.
          const on = spec.on;
          if (on.from !== BASE_RELATION && !byAlias.has(on.from)) {
            fail(
              `extension join "${alias}": its \`on\` names "${on.from}", which is not the base or a join declared before it (A4).`,
            );
          }
          if (on.from === alias) {
            fail(
              `extension join "${alias}": its \`on\` names the join itself (A4).`,
            );
          }
          if (primaryOf(spec.table) !== spec.key) {
            fail(
              `extension join "${alias}": its key "${spec.key.name}" is not the single-column primary key of "${getTableName(spec.table)}" — an extension is 1:1 with its parent (A4).`,
            );
          }
          const onCol = rawRender(on);
          if (onCol.getSQLType() !== spec.key.getSQLType()) {
            fail(
              `extension join "${alias}": its \`on\` "${onCol.name}" is ${onCol.getSQLType()}, but its key "${spec.key.name}" is ${spec.key.getSQLType()} — join on a column naming the parent's id (A4).`,
            );
          }
          pending.parent = on.from === BASE_RELATION ? null : on.from;
          pending.on = eq(own(spec.key, "key"), onCol);
          break;
        }
        if (spec.parentKey.table !== base.table) {
          fail(
            `extension join "${alias}" hangs off table "${getTableName(spec.parentKey.table)}", not the base "${baseName}" — an extension is joined onto its own parent (A4).`,
          );
        }
        if (primaryOf(spec.table) !== spec.key) {
          fail(
            `extension join "${alias}": its key "${spec.key.name}" is not the single-column primary key of "${getTableName(spec.table)}" — an extension is 1:1 with its host (A4).`,
          );
        }
        if (hostPk !== undefined && hostPk !== spec.parentKey) {
          fail(
            `extension join "${alias}" is keyed by "${spec.parentKey.name}", but this resource's identity is "${hostPk.name}" — a side row's key must BE the host id it refills.`,
          );
        }
        pending.on = eq(own(spec.key, "key"), spec.parentKey);
        break;
      }
      case "lookup": {
        if (spec.on.from !== BASE_RELATION && !byAlias.has(spec.on.from)) {
          fail(
            `lookup join "${alias}": its \`on\` names "${spec.on.from}", which is not the base or a join declared before it (A4).`,
          );
        }
        if (spec.on.from === alias) {
          fail(
            `lookup join "${alias}": its \`on\` names the join itself (A4).`,
          );
        }
        if (primaryOf(spec.table) !== spec.pk && !spec.pk.isUnique) {
          fail(
            `lookup join "${alias}": "${spec.pk.name}" is neither the primary key nor unique in "${getTableName(spec.table)}" — an N:1 lookup would multiply host rows (A4).`,
          );
        }
        pending.parent = spec.on.from === BASE_RELATION ? null : spec.on.from;
        pending.on = eq(own(spec.pk, "pk"), rawRender(spec.on));
        break;
      }
      case "keyed-side":
        pending.on = keyedSideOn(spec, own);
        break;
      case "rollup": {
        // N:1 on the rollup's key, LEFT (a host with no rollup row reads its
        // columns NULL). `on` is checked like a lookup's: the base or an
        // EARLIER join, never the join itself.
        if (spec.on.from !== BASE_RELATION && !byAlias.has(spec.on.from)) {
          fail(
            `rollup join "${alias}": its \`on\` names "${spec.on.from}", which is not the base or a join declared before it (A4).`,
          );
        }
        if (spec.on.from === alias) {
          fail(
            `rollup join "${alias}": its \`on\` names the join itself (A4).`,
          );
        }
        const keyColumn = (
          Object.values(getTableColumns(table)) as PgColumn[]
        ).find((c) => c.name === spec.rollup.key);
        if (keyColumn === undefined) {
          return fail(
            `rollup join "${alias}": rollup "${spec.rollup.table}" has no key column "${spec.rollup.key}" on its handle.`,
          );
        }
        const on = rawRender(spec.on);
        // The probe that resolves a source's changed keys to hosts compares
        // them against `on` in the key's type — a mismatch would also make
        // the join itself an implicit cast.
        if (on.getSQLType() !== keyColumn.getSQLType()) {
          fail(
            `rollup join "${alias}": its \`on\` "${on.name}" is ${on.getSQLType()}, but rollup "${spec.rollup.table}"'s key "${keyColumn.name}" is ${keyColumn.getSQLType()} — join on a column of the key's type (A4).`,
          );
        }
        assertHopsCovered(spec.rollup.sources, (problem) =>
          fail(
            `rollup join "${alias}": rollup "${spec.rollup.table}"'s ${problem} (A35).`,
          ),
        );
        pending.parent = spec.on.from === BASE_RELATION ? null : spec.on.from;
        pending.on = eq(own(keyColumn, "key"), on);
        break;
      }
      default:
        // Unreachable: `PLANNED_KINDS` refused every other kind above.
        return fail(`join "${alias}" has an unplanned kind "${kind}".`);
    }
    joins.push(pending);
  }

  for (const name of grouped.keys()) {
    if (name === BASE_RELATION || name === baseName || byAlias.has(name)) {
      fail(
        `the grouped relation "${name}" collides with the base or a join alias — every relation the SQL reads is named once.`,
      );
    }
  }

  // The host key a keyed side stores is compared as the side column's type
  // (a custom value's `row_key` is text, whatever the host id's type).
  function hostKeyed(hostKey: PgColumn): PgColumn | SQL {
    const host = hostCol();
    return host.getSQLType() === hostKey.getSQLType()
      ? host
      : sql`${host}::${sql.raw(hostKey.getSQLType())}`;
  }

  function keyedSideOn(
    spec: KeyedSideJoin,
    own: (col: PgColumn, role: string) => PgColumn,
  ): SQL {
    const covered = new Set<string>([
      spec.hostKey.name,
      ...spec.selectors.map((s) => s.col.name),
    ]);
    const missing = primaryColumns(spec.table).filter(
      (c) => !covered.has(c.name),
    );
    if (missing.length > 0) {
      fail(
        `keyed-side join "${spec.alias}": its selectors and hostKey leave primary-key column(s) ${missing.map((c) => `"${c.name}"`).join(", ")} of "${getTableName(spec.table)}" open — the join would multiply host rows (A4).`,
      );
    }
    return and(
      eq(own(spec.hostKey, "hostKey"), hostKeyed(spec.hostKey)),
      ...spec.selectors.map((s) => eq(own(s.col, "selector"), s.value)),
    )!;
  }

  // ── Join families: members compiled on first use ─────────────────────────
  const familyById = new Map<string, JoinFamily>();
  for (const family of families) {
    if (
      family.id === BASE_RELATION ||
      family.id === baseName ||
      byAlias.has(family.id) ||
      familyById.has(family.id)
    ) {
      fail(
        `join family "${family.id}" collides with the base, a join or another family — pick another id.`,
      );
    }
    for (const col of [
      family.hostKey,
      family.member,
      family.value,
      ...family.selectors.map((s) => s.col),
    ]) {
      if (col.table !== family.table) {
        fail(
          `join family "${family.id}": column "${col.name}" is not a column of its table "${getTableName(family.table)}" (A4).`,
        );
      }
    }
    familyById.set(family.id, family);
  }
  const memberJoins = new Map<string, CompiledJoin>();
  const memberOfAlias = new Map<
    string,
    { family: JoinFamily; member: string }
  >();
  const memberJoin = (family: JoinFamily, member: string): CompiledJoin => {
    const spec = familyMember(family, member);
    const alias = spec.alias;
    const cached = memberJoins.get(alias);
    if (cached) {
      const owner = memberOfAlias.get(alias)!;
      if (owner.family !== family || owner.member !== member) {
        fail(
          `join family "${family.id}": members "${owner.member}" and "${member}" make the same alias "${alias}".`,
        );
      }
      return cached;
    }
    if (utf8ByteLength(alias) > 63) {
      fail(
        `join family "${family.id}": member "${member}" makes the alias "${alias}", longer than Postgres's 63-byte identifier limit.`,
      );
    }
    if (byAlias.has(alias)) {
      fail(
        `join family "${family.id}": member "${member}"'s alias "${alias}" collides with a declared join.`,
      );
    }
    const rendered = aliasTable(spec.table, alias) as PgTable;
    const join: CompiledJoin = {
      spec,
      alias,
      table: spec.table,
      rendered,
      inner: false,
      parent: null,
      on: undefined as unknown as SQL,
    };
    const own = (col: PgColumn, role: string): PgColumn => {
      const key = keyOf(spec.table, col);
      if (key === undefined) {
        return fail(
          `join family "${family.id}": its ${role} "${col.name}" is not a column of table "${getTableName(spec.table)}" (A4).`,
        );
      }
      return renderRaw(join, key);
    };
    join.on = keyedSideOn(spec, own);
    memberJoins.set(alias, join);
    memberOfAlias.set(alias, { family, member });
    let shared = familyAliases.get(family);
    if (!shared) familyAliases.set(family, (shared = new Map()));
    shared.set(alias, member);
    return join;
  };
  // A member another plan rendered (the same family object), found by alias.
  const joinOfAlias = (name: string): CompiledJoin | undefined => {
    const join = byAlias.get(name) ?? memberJoins.get(name);
    if (join) return join;
    for (const family of familyById.values()) {
      const member = familyAliases.get(family)?.get(name);
      if (member !== undefined) return memberJoin(family, member);
    }
    return undefined;
  };

  const relationOf = (readCol: ReadColumn): string => {
    const col = columnOf(readCol);
    const name = getTableName(col.table);
    const isAlias = isJoinedColumn(col);
    if (!isAlias && name === baseName) return BASE_RELATION;
    if (isAlias && (grouped.has(name) || joinOfAlias(name))) return name;
    return fail(
      `the query reads relation "${name}" (column "${col.name}"), which is neither the base table "${baseName}" nor a declared join — declare it as a join, so the table is routed.`,
    );
  };

  const columnsIn = (
    fragment: unknown,
    opts?: { direct?: boolean },
  ): RelationColumn[] => {
    const direct = opts?.direct === true;
    const out: RelationColumn[] = [];
    // Guarded against revisits: a leaf chunk's `getSQL()` wraps itself.
    const seen = new Set<object>();
    const walk = (x: unknown): void => {
      if (x === null || x === undefined || typeof x !== "object") return;
      if (seen.has(x)) return;
      seen.add(x);
      if (is(x, StringChunk) || is(x, Name) || is(x, Placeholder)) return;
      if (Array.isArray(x)) {
        for (const c of x) walk(c);
        return;
      }
      if (is(x, Column)) {
        const col = x as PgColumn;
        out.push([relationOf(col), col.name]);
        return;
      }
      if (is(x, SQL)) {
        // An aggregate's SQL names a CTE or a rollup output — read its
        // declared provenance instead.
        const known = readExpressions.get(x as SQL);
        if (known?.kind === "aggregate") {
          if (!direct) walk(known.reads);
          return;
        }
        for (const c of (x as SQL).queryChunks) walk(c);
        return;
      }
      if (is(x, SQL.Aliased)) {
        walk((x as SQL.Aliased).sql);
        return;
      }
      if (is(x, Param)) return; // a bound value; its encoder is a column already walked
      if (is(x, View)) {
        fail(
          "the query reads a view — a routed compile reads base tables, whose changes its routes can name (A1).",
        );
      }
      if (is(x, Table)) {
        const name = getTableName(x as Table);
        if (name !== baseName && !grouped.has(name) && !joinOfAlias(name)) {
          fail(
            `the query reads table "${name}", which is neither the base table "${baseName}" nor a declared join — declare it as a join, so the table is routed.`,
          );
        }
        return;
      }
      if (is(x, Subquery)) {
        walk((x as Subquery)._.sql);
        return;
      }
      const getSQL = (x as { getSQL?: () => unknown }).getSQL;
      if (typeof getSQL === "function") walk(getSQL.call(x));
    };
    walk(fragment);
    return out;
  };

  const relationsIn = (fragment: unknown): Set<string> =>
    new Set(columnsIn(fragment).map(([r]) => r));

  const familyOf = (
    relation: string,
  ): { family: JoinFamily; member: string } | undefined => {
    if (byAlias.has(relation) || relation === BASE_RELATION) return undefined;
    return joinOfAlias(relation) === undefined
      ? undefined
      : memberOfAlias.get(relation);
  };

  const nameOf = (col: ReadColumn): string => {
    if (is(col, SQL)) {
      const known = expressionOf(col);
      return known.kind === "column" ? known.col.name : known.name;
    }
    return (col as PgColumn).name;
  };

  const memberOf = (col: ReadColumn): string | undefined => {
    if (isComputed(col)) return undefined;
    const relation = relationOf(col);
    return familyOf(relation) === undefined ? undefined : relation;
  };

  const relationKey = (col: ReadColumn): string => {
    if (!is(col, SQL)) return relationOf(col);
    const known = expressionOf(col);
    return known.kind === "column"
      ? relationOf(col)
      : `${known.kind}:${known.name}`;
  };

  // ── ExprField: rendered once per plan ─────────────────────────────────────
  // Whether a fragment is exactly ONE column read (through any wrapping that
  // adds nothing: blank text, a ref, a plain `sql\`${col}\``).
  const bareColumn = (x: unknown): boolean => {
    if (is(x, Column)) return true;
    // A leaf chunk is never a column — and its `getSQL()` wraps itself, so
    // following it would recurse forever (a tail call: no stack overflow).
    if (
      is(x, StringChunk) ||
      is(x, Param) ||
      is(x, Name) ||
      is(x, Placeholder)
    ) {
      return false;
    }
    if (is(x, SQL)) {
      if (readExpressions.get(x as SQL)?.kind === "column") return true;
      const chunks = (x as SQL).queryChunks.filter(
        (c) =>
          !(
            is(c, StringChunk) &&
            (c as StringChunk).value.join("").trim() === ""
          ),
      );
      return chunks.length === 1 && bareColumn(chunks[0]);
    }
    const getSQL = (x as { getSQL?: () => unknown } | null)?.getSQL;
    return typeof getSQL === "function" && bareColumn(getSQL.call(x));
  };
  const renderedExprs = new WeakMap<ExprField, SQL>();
  const renderExpr = (
    field: ExprField,
    opts: { name: string; baseColumns: Readonly<Record<string, PgColumn>> },
  ): SQL => {
    const cached = renderedExprs.get(field);
    if (cached !== undefined) return cached;
    const where = `expression field "${opts.name}"`;
    // Re-checked at the boundary every compile passes through: the type is
    // interpolated raw into a cut's cast.
    if (!SQL_TYPE_RE.test(field.sqlType)) {
      fail(
        `${where} declares sqlType "${field.sqlType}", which is not a Postgres type name (${SQL_TYPE_RE.source}) — it is interpolated raw into casts.`,
      );
    }
    if (bareColumn(field.sql)) {
      fail(
        `${where} is exactly one column — bind it with a column override (\`(j) => j.<relation>.<column>\`), which types and routes it as that column.`,
      );
    }
    for (const col of field.serverOnly) {
      if (col.table !== base.table) {
        fail(
          `${where} declares server-only column "${col.name}" of table "${getTableName(col.table)}", which is not the base table "${baseName}" — a server-only read is a base column, named by the table's own column.`,
        );
      }
    }
    // Parenthesised, so an operator inside binds before any cast or operator
    // a shape wraps it in (`(…)::text`, a cut's comparison).
    const rendered = sql`(${field.sql})`.mapWith(field.decoder);
    readExpressions.set(rendered, {
      kind: "expr",
      name: opts.name,
      nullable: !field.notNull,
      sqlType: field.sqlType,
    });
    // Provenance, read off the SQL: every relation it reads is the base or a
    // declared join (a correlated subquery over another table throws), and
    // every column a wire column of its relation or a declared server-only one.
    const wireOf = (relation: string): ReadonlySet<string> => {
      if (relation === BASE_RELATION) {
        return new Set([
          ...Object.values(opts.baseColumns).map((c) => c.name),
          ...field.serverOnly.map((c) => c.name),
        ]);
      }
      const join = byAlias.get(relation);
      if (join === undefined) return new Set();
      // A rollup's handle carries no server-only column: all of it is wire.
      const wire =
        join.spec.kind === "rollup" ? undefined : join.spec.wireColumns;
      return new Set(
        Object.values(
          wire ?? (getTableColumns(join.table) as Record<string, PgColumn>),
        ).map((c) => c.name),
      );
    };
    for (const [relation, column] of columnsIn(rendered)) {
      // A grouped relation's column reaches the expression only through an
      // aggregate (its declared provenance): never the wire itself.
      if (grouped.has(relation)) continue;
      if (!wireOf(relation).has(column)) {
        fail(
          `${where} reads "${relation}"."${column}", which is not a wire column of that relation — a server-only base column is read only when declared in the expression's \`serverOnly\` (its value reaches the wire through the expression).`,
        );
      }
    }
    renderedExprs.set(field, rendered);
    return rendered;
  };

  // ── Aggregates: provenance declared, not read off the SQL ────────────────
  // The relation an aggregate belongs to must be one THIS plan declares — at
  // registration, and again wherever a plan reads one another plan registered
  // (the registry is module-level), so `outer` never walks an unknown alias.
  const assertAggregateRelation = (name: string, relation: string): void => {
    if (
      relation !== BASE_RELATION &&
      !grouped.has(relation) &&
      joinOfAlias(relation) === undefined
    ) {
      fail(
        `aggregate "${name}" belongs to relation "${relation}", which is neither the base nor a declared join.`,
      );
    }
  };
  // One rendering per (relation, name), like `renderExpr`'s per field: the
  // result's identity is what memos of renderings key on (`arm-plan`'s
  // expression ids, its order memo), so a second call — a per-params order
  // resolving the same aggregate — must hand back the same object, never
  // mint a fresh one. A re-registration that disagrees with the first is a
  // bug, refused.
  const renderedAggregates = new Map<
    string,
    {
      rendered: SQL;
      text: { sql: string; params: unknown[] };
      opts: Parameters<JoinPlan["renderAggregate"]>[1];
    }
  >();
  const renderAggregate: JoinPlan["renderAggregate"] = (fragment, opts) => {
    const where = `aggregate "${opts.name}"`;
    const cacheKey = `${opts.relation}\u0000${opts.name}`;
    const text = new PgDialect().sqlToQuery(fragment);
    const cached = renderedAggregates.get(cacheKey);
    if (cached !== undefined) {
      const was = cached.opts;
      const same =
        cached.text.sql === text.sql &&
        cached.text.params.length === text.params.length &&
        cached.text.params.every((v, i) => Object.is(v, text.params[i])) &&
        was.reads.length === opts.reads.length &&
        was.reads.every((r, i) => r === opts.reads[i]) &&
        was.nullable === opts.nullable &&
        was.sqlType === opts.sqlType &&
        was.decoder === opts.decoder;
      if (!same) {
        fail(
          `${where} (of relation "${opts.relation}") is re-registered with a different SQL, reads, nullability, sqlType or decoder — one name is one aggregate per plan; render it once and reuse the result.`,
        );
      }
      return cached.rendered;
    }
    if (!SQL_TYPE_RE.test(opts.sqlType)) {
      fail(
        `${where} declares sqlType "${opts.sqlType}", which is not a Postgres type name (${SQL_TYPE_RE.source}) — it is interpolated raw into casts.`,
      );
    }
    assertAggregateRelation(opts.name, opts.relation);
    // Walked before registering: a read naming an undeclared relation throws
    // here, and reads that name no column at all are refused.
    if (columnsIn(opts.reads).length === 0) {
      fail(
        `${where} declares reads that resolve to no relation column — no route would reach it, so a change to what it aggregates would leave it silently stale. Declare the columns it is computed from, rendered through the plan.`,
      );
    }
    const rendered = sql`(${fragment})`.mapWith(opts.decoder);
    readExpressions.set(rendered, {
      kind: "aggregate",
      name: opts.name,
      relation: opts.relation,
      reads: [...opts.reads],
      nullable: opts.nullable,
      sqlType: opts.sqlType,
    });
    renderedAggregates.set(cacheKey, { rendered, text, opts: { ...opts } });
    return rendered;
  };

  const closure = (seeds: Iterable<string>): Set<string> => {
    const out = new Set<string>();
    for (const seed of seeds) {
      let at: string | null = seed === BASE_RELATION ? null : seed;
      while (at !== null && !out.has(at)) {
        out.add(at);
        // A grouped relation hangs off nothing row-wise: its CTE is joined
        // on the host's identity.
        at = grouped.has(at) ? null : joinOfAlias(at)!.parent;
      }
    }
    return out;
  };

  const outer = (relation: string): boolean => {
    // A grouped relation is read only through an aggregate, whose `ifNone`
    // (or its declared nullability) is what a host with no group row reads.
    if (grouped.has(relation)) return false;
    let at: string | null = relation === BASE_RELATION ? null : relation;
    while (at !== null) {
      const join = joinOfAlias(at)!;
      if (!join.inner) return true;
      at = join.parent;
    }
    return false;
  };

  const required = new Set(joins.filter((j) => j.inner).map((j) => j.alias));
  // An INNER join below a LEFT one: its ancestors are read as membership too
  // (`closure`), since a missing ancestor row drops the host.

  const conditionColumns = joins.flatMap((j) => columnsIn(j.on));

  const routeIdsOf = (alias: string): readonly string[] => {
    const join =
      byAlias.get(alias) ??
      fail(`routeIdsOf: no declared join has the alias "${alias}".`);
    return join.spec.kind === "rollup"
      ? join.spec.rollup.sources.map((s) => rollupRouteId(alias, s.table))
      : [alias];
  };

  // Each rollup's table once, whatever the number of joins reading it — the
  // same rollup is moved by the same sources however it is joined.
  const derived = new Map<string, DerivedRead>();
  for (const j of joins) {
    if (j.spec.kind !== "rollup") continue;
    const { rollup } = j.spec;
    if (!derived.has(rollup.table)) {
      derived.set(rollup.table, {
        table: rollup.table,
        sources: rollup.sources.map((s) => s.table),
      });
    }
  }
  const derivedReads = [...derived.values()];

  return {
    baseName,
    joins,
    required,
    render,
    // Every column of every relation — a predicate may read a server-only
    // column, which never reaches the wire.
    columns: () => {
      const rendered = (from: string, table: PgTable) =>
        Object.fromEntries(
          Object.entries(
            getTableColumns(table) as Record<string, PgColumn>,
          ).map(([k, col]) => [k, rawRender({ from, col })]),
        );
      return {
        [BASE_RELATION]: rendered(BASE_RELATION, base.table),
        ...Object.fromEntries(
          joins.map((j) => [j.alias, rendered(j.alias, j.table)]),
        ),
      };
    },
    relationOf,
    columnOf,
    isComputed,
    nameOf,
    memberOf,
    relationKey,
    renderExpr,
    renderAggregate,
    canBeNull: (col) => {
      if (!is(col, SQL)) {
        return !(col as PgColumn).notNull || outer(relationOf(col));
      }
      const known = expressionOf(col);
      // An aggregate belongs to a relation: through a LEFT join (its own or
      // an ancestor's) a host with no joined row reads it NULL, whatever it
      // declares — the rule a column read follows.
      if (known.kind !== "aggregate") return known.nullable;
      // Registered by any plan (module-level): its relation must be this
      // plan's before `outer` walks it.
      assertAggregateRelation(known.name, known.relation);
      return known.nullable || outer(known.relation);
    },
    columnsIn,
    isGrouped: (relation) => grouped.has(relation),
    relationsIn,
    closure,
    outer,
    apply(q, included) {
      let out = q;
      for (const j of joins) {
        if (!included.has(j.alias)) continue;
        out = j.inner
          ? out.innerJoin(j.rendered, j.on)
          : out.leftJoin(j.rendered, j.on);
      }
      // Family members, in alias order (a stable statement per member set).
      const members = [...included]
        .filter((alias) => !byAlias.has(alias))
        .sort();
      for (const alias of members) {
        const j = joinOfAlias(alias);
        if (j === undefined) {
          fail(
            `the tuple includes relation "${alias}", which no join declares.`,
          );
        }
        out = out.leftJoin(j!.rendered, j!.on);
      }
      return out;
    },
    conditionColumns,
    routeIdsOf,
    derivedReads,
    families,
    readMember(familyId, member, read) {
      const family =
        familyById.get(familyId) ??
        fail(`no join family "${familyId}" is declared on this compile.`);
      const join = memberJoin(family, member);
      const key = keyOf(family.table, family.value)!;
      const raw = renderRaw(join, key);
      if (read === undefined) return raw;
      const cacheKey = `${join.alias}\u0000${key}\u0000${read.sqlType}`;
      let expr = defaultedCache.get(cacheKey);
      if (expr === undefined) {
        expr = read.cast(raw);
        defaultedCache.set(cacheKey, expr);
        readExpressions.set(expr, {
          kind: "column",
          col: raw,
          nullable: true,
          sqlType: read.sqlType,
        });
      }
      return expr;
    },
    familyOf,
    sqlTypeOf: (col) =>
      is(col, SQL) ? expressionOf(col).sqlType : (col as PgColumn).getSQLType(),
  };
}

// Every primary-key column of a table (compared by name — a table-level
// declaration's columns are not the table's own objects): a table-level
// declaration (`primaryKey({ columns })`), else the inline `.primaryKey()`
// columns.
export function primaryColumns(table: PgTable): PgColumn[] {
  const declared = getTableConfig(table).primaryKeys[0];
  if (declared) return declared.columns;
  return Object.values(
    getTableColumns(table) as Record<string, PgColumn>,
  ).filter((c) => c.primary);
}

/** What a keyed compile's join routes are resolved against: the host and the plan. */
export interface JoinRouteHost {
  /** The base table's routed name and table — what a reverse query reads the hosts from. */
  base: RoutedBase;
  /** The host's identity column: its values are the host ids. */
  pk: PgColumn;
  plan: JoinPlan;
  db: QueryDb;
}

/**
 * The hosts a reverse probe resolves to: `SELECT DISTINCT <host pk> FROM
 * <base> [the joins of \`chain\`] WHERE <probe> [AND <host pk> =
 * ANY($within)] LIMIT cap + 1`, `"over-cap"` past the cap. `within` is cast
 * under `withinPolicy` (see `InvalidIdPolicy`).
 */
async function probeHosts(
  host: JoinRouteHost,
  chain: ReadonlySet<string>,
  probe: SQL,
  within: ReadonlySet<string> | null,
  withinPolicy: InvalidIdPolicy,
  cap: number,
): Promise<readonly string[] | "over-cap"> {
  const { plan, db, pk, base } = host;
  const rows = await plan
    .apply(
      db.selectDistinct<{ id: unknown }>({ id: pk }).from(base.table),
      chain,
    )
    .where(
      within === null
        ? probe
        : and(probe, anyOf(pk, [...within], { invalid: withinPolicy }))!,
    )
    .limit(cap + 1);
  return rows.length > cap ? "over-cap" : rows.map((r) => String(r.id));
}

/** The joins a probe through `on` reads: the relation `on` belongs to and its ancestors. */
function chainOf(plan: JoinPlan, on: ColumnRef): Set<string> {
  return on.from === BASE_RELATION
    ? new Set<string>()
    : plan.closure([on.from]);
}

/**
 * A lookup's `reverse` route map (the host side references the looked-up row):
 * the changed rows' `pk` values (`change.ids` when `pk` is the table's primary
 * key, else the carried `pk` column) are resolved, in the drain, to the hosts whose
 * `on` column names one — `SELECT DISTINCT <host pk> FROM <base> [the lookup
 * chain up to \`on\`'s relation] WHERE on = ANY($changed) [AND pk = ANY($within)]
 * LIMIT cap + 1`, `"over-cap"` past the cap.
 *
 * Complete after commit by the FK-direction rule (A10 of
 * research/2026-09-29-global-scoped-change-routing.md): the referencing column
 * lives on HOST-side rows — the base, or an earlier join of the chain — which
 * still hold it whatever happened to the looked-up row (`events WHERE
 * source_id = ANY($changed)` finds a deleted source's events). A chain whose
 * hop reads the CHANGED table itself (an earlier join over the same table)
 * would read the post-image of the very rows that changed, and needs their
 * pre-image, which no layout carries for it: that route is `full`, with the
 * reason.
 */
function reverseMap(
  join: CompiledJoin,
  host: JoinRouteHost,
): Extract<RawHostMap, { kind: "reverse" | "full" }> {
  const spec = join.spec;
  // A lookup, or a related host's extension (`on` set): both are keyed on a
  // column of the joined table (`pk` / `key`) matched by a host-side `on`.
  const keyed =
    spec.kind === "lookup"
      ? { table: spec.table, pk: spec.pk, on: spec.on }
      : spec.kind === "extension" && spec.on !== undefined
        ? { table: spec.table, pk: spec.key, on: spec.on }
        : undefined;
  if (keyed === undefined) {
    throw new Error(
      `reverseMap: join "${join.alias}" is neither a lookup nor an extension keyed by \`on\``,
    );
  }
  const { plan } = host;
  const table = getTableName(keyed.table);
  const chain = chainOf(plan, keyed.on);
  for (const alias of chain) {
    const hop = plan.joins.find((j) => j.alias === alias)!;
    if (getTableName(hop.table) === table) {
      return {
        kind: "full",
        reason: `pre-image needed: lookup "${join.alias}" is reached through "${alias}", a join over the changed table "${table}" itself — resolved after commit, the probe would read the rows that changed (A10)`,
      };
    }
  }
  const on = plan.columnOf(plan.render(keyed.on));
  return {
    kind: "reverse",
    // On the changed table's own PK the changed values ARE `change.ids`, so no
    // key need be carried (the rule `joinRoute`'s alias arm applies); a lookup
    // on a UNIQUE non-PK column (A4) reads that column off the carried keys.
    ...(tablePrimary(keyed.table) === keyed.pk
      ? {}
      : { column: keyed.pk.name }),
    resolve: async (changed, within, cap) => {
      if (changed.length === 0 || (within !== null && within.size === 0)) {
        return [];
      }
      // `changed` is vouched for — a change's own keys, so a bad one is a
      // broken invariant and throws. `within` is NOT always: for a point
      // reader it is the client's own `:rows` id set (the runtime's
      // `reverseWithin`; a union decodes it straight to raw arm ids), so a key
      // the pk type cannot hold (`uuidarm:x`) fails this probe with an
      // invalid-input error and every bounded reader of the entry goes FULL.
      // `"absent"` is the right policy for `within` (it only bounds the
      // answer); it changes the uuid arm's probe SQL in the union snapshot, so
      // it lands as its own step with a regenerated, reviewed fixture — step
      // 16b.1a of research/2026-10-06-global-scoped-change-routing-p8-v3.md.
      return probeHosts(
        host,
        chain,
        anyOf(on, changed, { invalid: "throws" }),
        within,
        "throws",
        cap,
      );
    },
  };
}

/** The route of one window join, for a keyed (routed) compile — see `JoinSpec`. */
function joinRoute(
  join: CompiledJoin,
  spec: JoinSpec,
  host: JoinRouteHost,
  columns: readonly string[],
): RawRoute {
  const base = { id: join.alias, table: getTableName(spec.table), columns };
  switch (spec.kind) {
    case "extension":
      // A related host's extension (`on` not the host identity) is resolved
      // in the drain like a lookup (see `reverseMap`).
      if (
        spec.on !== undefined &&
        !(spec.on.from === BASE_RELATION && spec.on.col === host.pk)
      ) {
        return { ...base, map: reverseMap(join, host) };
      }
      // The key IS the side table's primary key (checked): its ids are host ids.
      return { ...base, map: { kind: "alias" } };
    case "lookup": {
      if (spec.on.from === BASE_RELATION && spec.on.col === host.pk) {
        // Keyed by the host's own id: an extension in all but name.
        return {
          ...base,
          map:
            tablePrimary(spec.table) === spec.pk
              ? { kind: "alias" }
              : { kind: "alias", column: spec.pk.name },
        };
      }
      // The host side references it: resolved in the drain (see `reverseMap`).
      return { ...base, map: reverseMap(join, host) };
    }
    case "keyed-side":
      return {
        ...base,
        map: { kind: "alias", column: spec.hostKey.name },
        rows: Object.fromEntries(
          spec.selectors.map((s) => [s.col.name, s.value]),
        ),
      };
  }
}

/**
 * A rollup's route on one of its sources: `<alias>[<source table>]` — the
 * rollup table itself is never routed (A1: it has no change-feed trigger).
 */
export function rollupRouteId(alias: string, sourceTable: string): string {
  return `${alias}[${sourceTable}]`;
}

/**
 * The route of one SOURCE of a rollup join (v2's route table, *rollup*): a
 * write to the source re-aggregates the rollup rows its `carry` values name —
 * through `via` when declared — so it reaches the hosts whose `on` reads one of
 * those keys.
 *
 * - **Columns** (the `unchanged` gate): the source's pk, `carry` and `reads` —
 *   exactly what its maintain function diffs, so a write the rollup ignores
 *   (`waiting_for` on conversations) reaches no reader either.
 * - **`on` = the host's own pk, no `via`:** the carried values ARE host ids,
 *   so the map is an `alias` on `carry` (a source row I / U / D is a host U) —
 *   on `change.ids` when `carry` is the source's single-column pk.
 * - **Otherwise** a `reverse` map over the carried values, probed after commit
 *   like a lookup's (`probeHosts`): `on = ANY($keys)`, the keys being the
 *   values themselves or, with `via`, `SELECT key FROM via WHERE match =
 *   ANY($values)`. The hop is read as the maintain function reads it, so the
 *   probe resolves what the rollup re-aggregated: a write that moves or removes
 *   the hop row resolves only its new keys in either, so the hop table must be
 *   a source of its own whose `carry` is the hop's key — refused at compile
 *   otherwise (A35, `compilePlan`). A hop or a chain join over the
 *   CHANGED source table itself would read the post-image of the rows that
 *   changed (A10): that route is `full`, with the reason.
 *
 * `within` is cast with `{ invalid: "absent" }`: it only bounds the answer, and
 * for a point reader it is the client's own id set (16b.1a's policy).
 */
function rollupSourceRoute(
  join: CompiledJoin,
  spec: RollupJoin,
  src: CompiledRollupSource,
  host: JoinRouteHost,
): RawRoute {
  const { plan } = host;
  const id = rollupRouteId(join.alias, src.table);
  const columns = [...new Set([...src.pk, src.carry, ...src.reads])].sort();
  const keyed =
    src.pk.length === 1 && src.pk[0] === src.carry ? {} : { column: src.carry };
  const route = { id, table: src.table, columns };
  if (
    src.via === undefined &&
    spec.on.from === BASE_RELATION &&
    spec.on.col === host.pk
  ) {
    return { ...route, map: { kind: "alias", ...keyed } };
  }
  const chain = chainOf(plan, spec.on);
  const preImage = (through: string): RawRoute => ({
    ...route,
    map: {
      kind: "full",
      reason: `pre-image needed: rollup "${join.alias}"'s source "${src.table}" is resolved through ${through}, which reads the changed table "${src.table}" itself — resolved after commit, the probe would read the rows that changed (A10)`,
    },
  });
  if (src.via?.table === src.table) return preImage(`its own via hop`);
  for (const alias of chain) {
    const hop = plan.joins.find((j) => j.alias === alias)!;
    if (getTableName(hop.table) === src.table) {
      return preImage(`the join "${alias}"`);
    }
  }
  const via = src.via;
  return {
    ...route,
    map: {
      kind: "reverse",
      ...keyed,
      resolve: async (changed, within, cap) => {
        if (changed.length === 0 || (within !== null && within.size === 0)) {
          return [];
        }
        const on = plan.columnOf(plan.render(spec.on));
        // The carried values are vouched for (a change's own keys): a bad one
        // fails the cast. `on` has the key's type (asserted at compile), and
        // so has a carry with no `via`; a `via` match has the carry's.
        const keys =
          via === undefined
            ? anyOf(on, changed, { invalid: "throws" })
            : sql`${on} IN (SELECT ${sql.identifier(via.key)} FROM ${sql.identifier(via.table)} WHERE ${sql.identifier(via.match)} = ANY(${sql.param([...changed])}::${sql.raw(src.carryType)}[]))`;
        return probeHosts(host, chain, keys, within, "absent", cap);
      },
    },
  };
}

/**
 * The routes of one declared join (C8 of
 * research/2026-10-06-global-scoped-change-routing-p8-v3.md): one route for a
 * window join (id = its alias, `columns` = what the SQL reads of it —
 * `columnsOf(alias)`), one per SOURCE for a rollup (`rollupSourceRoute`; its
 * gate is the rollup's own declaration, not the reader's SQL). A tuple reading
 * the join names every id `JoinPlan.routeIdsOf(alias)` lists, in this order.
 */
export function joinRoutes(
  join: CompiledJoin,
  host: JoinRouteHost,
  columnsOf: (relation: string) => readonly string[],
): RawRoute[] {
  const spec = join.spec;
  if (spec.kind === "rollup") {
    return spec.rollup.sources.map((src) =>
      rollupSourceRoute(join, spec, src, host),
    );
  }
  return [joinRoute(join, spec, host, columnsOf(join.alias))];
}

/**
 * The one route of a join family: an `alias` on its host key, kept to its
 * scope's rows (`rows` = the selectors) and, per tuple, to the members it reads
 * (`match` on the member column). Its `columns` are the ones every member's
 * join and read touch: the key columns and the value.
 */
export function familyRoute(family: JoinFamily): RawRoute {
  const read = new Set<string>([
    family.hostKey.name,
    family.member.name,
    family.value.name,
    ...family.selectors.map((s) => s.col.name),
  ]);
  return {
    id: family.id,
    table: getTableName(family.table),
    map: { kind: "alias", column: family.hostKey.name },
    rows: Object.fromEntries(
      family.selectors.map((s) => [s.col.name, s.value]),
    ),
    match: [family.member.name],
    columns: Object.values(
      getTableColumns(family.table) as Record<string, PgColumn>,
    )
      .map((c) => c.name)
      .filter((c) => read.has(c)),
  };
}

/**
 * Each relation's route `columns`: every column of it the compiled SQL may
 * reference, over every tuple — `reads` (projection, identity, join conditions,
 * a static `where`, the declared per-params `where` columns, the order
 * signature). `open` — a per-params `where` whose columns nobody declared — makes
 * it every column of every relation, the safe over-approximation (the
 * `unchanged` gate then never skips).
 */
export function routeColumnsOf(
  plan: JoinPlan,
  base: RoutedBase,
  reads: readonly RelationColumn[],
  open: boolean,
): (relation: string) => string[] {
  const tableOf = (relation: string): PgTable =>
    relation === BASE_RELATION
      ? base.table
      : plan.joins.find((j) => j.alias === relation)!.table;
  const byRelation = new Map<string, Set<string>>();
  for (const [relation, column] of [...reads, ...plan.conditionColumns]) {
    let set = byRelation.get(relation);
    if (!set) byRelation.set(relation, (set = new Set()));
    set.add(column);
  }
  return (relation) => {
    // Table order, so a plan's routes are stable to read.
    const all = Object.values(
      getTableColumns(tableOf(relation)) as Record<string, PgColumn>,
    ).map((c) => c.name);
    if (open) return all;
    const set = byRelation.get(relation) ?? new Set<string>();
    return all.filter((c) => set.has(c));
  };
}
