import {
  getTableColumns,
  getTableName,
  is,
  sql,
  SQL,
  type SQLWrapper,
} from "drizzle-orm";
import {
  alias as aliasTable,
  getTableConfig,
  type PgColumn,
  type PgTable,
} from "drizzle-orm/pg-core";
import type {
  CompiledRollupSource,
  Rollup,
} from "@plugins/database/plugins/derived-tables/core";
import { columnWireCodec } from "@plugins/database/plugins/sql-column/server";
import { decodedRow } from "@plugins/database/plugins/sql-projection/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import type {
  DerivedRead,
  TupleUse,
} from "@plugins/framework/plugins/resource-runtime/core";
import {
  isAggregate,
  type Aggregate,
  type AggregateSet,
  type ChildrenJoin,
  type ClosureJoin,
  type NestedRollupJoin,
  type TypedColumnRef,
} from "@plugins/infra/plugins/query-resource/core";
import {
  assertHopsCovered,
  primaryColumns,
  rollupRouteId,
  type JoinPlan,
} from "./joins";
import { allOf, anyOf, anyOfExpr, canonicalSqlType } from "./raw-sql";
import { tablePrimary, type RawRoute, type RoutedBase } from "./routes";
import type { QueryDb } from "./spec";

// The GROUPED half of the `all` compiler (`./compile-alias`; P8 v3 §4.1 of
// research/2026-10-06-global-scoped-change-routing-p8-v3.md): a children or
// closure join is never joined row-wise — it is a GROUP BY CTE keyed by the
// host's identity, LEFT-joined to the base, read only through the aggregates
// it declares. This module owns:
//
// - the INTERNAL RELATIONS of each join (`<a>` the child table, `<a>__<r>` a
//   rollup under it; `<a>` the closure's edge table, `<a>__anc` its ancestor
//   row, `<a>__anc__<j>` a join hung off the ancestor, `<a>__anc__<c>__<r>` a
//   rollup under an ancestor's children) — each its table aliased under that
//   name, so a column read off the SQL names its relation (`JoinPlan`
//   resolves them as grouped relations);
// - the aggregate rendering: the CTE body (`jsonAgg` rendered here, A39), and
//   the outer read `COALESCE(<cte>."<name>", <ifNone>)` registered through
//   `JoinPlan.renderAggregate` with its provenance (C7);
// - the CTE text for the FULL shape (set-based: every group in one pass, the
//   closure one recursive `UNION`, so a cycle terminates) and the SCOPED one
//   (the same CTEs restricted to the hosts asked for; the closure walked by a
//   `CROSS JOIN LATERAL (… OFFSET 0)`, the ancestors' groups restricted by an
//   `ANY(ARRAY(SELECT DISTINCT …))` InitPlan and the ancestor row reached by a
//   pk lateral — the planner fences pinned in the text, A32);
// - the routes (v2's route table): `<a>` an alias on the child's `fk` (or the
//   edge's `child`), `<a>__<r>[<src>]` a nested rollup's source resolved
//   through the child rows, and under a closure the dependents expansion
//   `…:closure` — a change to a node reaches every node it is an ancestor of
//   (the dependents probe: an `OFFSET 0` lateral over the `parent` index).
//
// CTE names are rendered UNQUOTED and match `CTE_NAME_RE` (A38): a quoted name
// in a FROM / JOIN clause is a captured read-set relation
// (`database/server`'s `quotedRelationsIn`), so a quoted CTE would be a
// phantom dependency every load reports.

/** A38: the CTE names the `all` compiler renders, unquoted. */
export const CTE_NAME_RE = /^__[a-z0-9_]{1,60}$/;

/** A grouped join's alias: what its CTE and internal relations are named from. */
const GROUPED_ALIAS_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** A `jsonAgg` field name: rendered as a SQL string literal. */
const JSON_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A39: the child column types a `jsonAgg` may carry (canonical spellings). */
const JSON_AGG_TYPES: ReadonlySet<string> = new Set([
  "text",
  "boolean",
  "integer",
  "timestamp with time zone",
  "json",
  "jsonb",
  "text[]",
]);

/** A dependents probe takes its `within` into SQL up to this many ids; past it, filters in JS. */
export const WITHIN_IN_SQL_MAX = 256;

/** A grouped join: a children or closure join. */
export type GroupedJoinSpec = ChildrenJoin | ClosureJoin;

type Fail = (message: string) => never;

/** A ref a callback is handed: a column of an internal relation, rendering as it. */
interface InternalColumnRef extends SQLWrapper {
  readonly from: string;
  readonly col: PgColumn;
}

/** An aggregate ref: renders as the aggregate's registered outer read. */
export interface AggregateRefRuntime extends SQLWrapper {
  readonly from: string;
  readonly aggregate: string;
}

/**
 * Every internal relation of `specs`, by name, with the table it aliases —
 * what the plan registers as its grouped relations (`compileAllJoins`), BEFORE
 * any column of them is rendered. Throws on a grouped alias that is not
 * lower-snake (its CTE name is rendered unquoted, A38), a relation name past
 * Postgres's identifier limit, and on two relations of one name.
 */
export function groupedRelationsOf(
  specs: readonly GroupedJoinSpec[],
  fail: Fail,
): Map<string, PgTable> {
  const out = new Map<string, PgTable>();
  const add = (name: string, table: PgTable): void => {
    if (out.has(name)) {
      fail(`the grouped relation "${name}" is named twice.`);
    }
    // `__c_<name>` must still match CTE_NAME_RE.
    if (!CTE_NAME_RE.test(`__c_${name}`)) {
      fail(
        `the grouped relation "${name}" makes the CTE name "__c_${name}", which is not ${CTE_NAME_RE.source} (A38) — a CTE is rendered unquoted, so its name is lower-snake and short. Shorten the join's alias.`,
      );
    }
    out.set(name, table);
  };
  const alias = (a: string, what: string): void => {
    if (!GROUPED_ALIAS_RE.test(a)) {
      fail(
        `${what} alias "${a}" is not lower-snake (${GROUPED_ALIAS_RE.source}) — a grouped join's CTE is named from it and rendered unquoted (A38).`,
      );
    }
  };
  const children = (prefix: string, c: ChildrenJoin): void => {
    alias(c.alias, "a children join's");
    const rel = prefix + c.alias;
    add(rel, c.table);
    for (const r of c.rollups) {
      alias(r.alias, `children join "${c.alias}"'s rollup`);
      add(`${rel}__${r.alias}`, r.rollup.handle);
    }
  };
  for (const spec of specs) {
    if (spec.kind === "children") {
      children("", spec);
      continue;
    }
    alias(spec.alias, "a closure join's");
    add(spec.alias, spec.edges);
    add(`${spec.alias}__anc`, spec.nodes);
    for (const j of spec.ancestorJoins) {
      if (j.kind === "children") children(`${spec.alias}__anc__`, j);
      else {
        alias(j.alias, `closure "${spec.alias}"'s ancestor rollup`);
        add(`${spec.alias}__anc__${j.alias}`, j.rollup.handle);
      }
    }
  }
  return out;
}

// ── Compiled shapes ─────────────────────────────────────────────────────────

interface CompiledAggregate {
  name: string;
  agg: Aggregate;
  /** The CTE's per-group expression. */
  body: SQL;
}

interface CompiledNestedRollup {
  spec: NestedRollupJoin;
  rel: string;
  /** The host relation's own `on` column. */
  onOwn: PgColumn;
  /** `<key> = <on>`, rendered. */
  on: SQL;
}

interface CompiledChildren {
  spec: ChildrenJoin;
  rel: string;
  cte: string;
  table: PgTable;
  /** The rendered `fk` — the CTE's group key. */
  fk: PgColumn;
  /** The child table's primary key, rendered (the `jsonAgg` tiebreaker). */
  pk: readonly PgColumn[];
  rollups: readonly CompiledNestedRollup[];
  where: SQL | undefined;
  aggregates: readonly CompiledAggregate[];
  /** The child table's route `columns`: fk, pk, and every column the where / aggregates / rollup joins read. */
  gate: readonly string[];
}

interface CompiledClosure {
  spec: ClosureJoin;
  rel: string;
  /** The (node, ancestor) pairs. */
  pairs: string;
  /** The per-node aggregates. */
  cte: string;
  /** The dependents probe's walk. */
  deps: string;
  child: PgColumn;
  parent: PgColumn;
  anc: { rel: string; pk: PgColumn };
  ancRollups: readonly CompiledNestedRollup[];
  ancChildren: readonly CompiledChildren[];
  aggregates: readonly CompiledAggregate[];
  /** The edge table's route `columns`: child and parent. */
  edgeGate: readonly string[];
  /** The node table's route `columns` for the dependents route. */
  nodeGate: readonly string[];
}

type CompiledGrouped =
  | ({ kind: "children" } & CompiledChildren)
  | ({ kind: "closure" } & CompiledClosure);

/** Which hosts a CTE set is computed for. */
export type GroupedScope =
  | { kind: "full" }
  | {
      kind: "scoped";
      /** `col = ANY(<the hosts>)` — the ids and their invalid-id policy are the caller's. */
      hostIn: (col: PgColumn) => SQL;
    };

/** The grouped half of an `all` compile. */
export interface GroupedPlan {
  /** The top-level grouped joins' aliases, in declaration order. */
  aliases: readonly string[];
  /** `j.<alias>`'s aggregate refs. */
  refs: ReadonlyMap<string, Readonly<Record<string, AggregateRefRuntime>>>;
  /** The CTEs (`name AS (…)`) the projection's grouped joins need, in dependency order. */
  ctes(scope: GroupedScope): SQL[];
  /** Whether any CTE is recursive (a closure). */
  recursive: boolean;
  /** `LEFT JOIN <cte> ON <cte>.__k = <host pk>` per top-level grouped join. */
  outerJoins(hostPk: PgColumn): SQL[];
  /** The routes of every grouped join. */
  routes: readonly RawRoute[];
  /** Every grouped route's use (value: an aggregate never moves membership). */
  uses: ReadonlyMap<string, TupleUse>;
  /** The rollups the CTEs read (each table once). */
  derivedReads: readonly DerivedRead[];
  rollups: readonly Rollup[];
}

const VALUE: TupleUse = { role: "value" };

/**
 * The grouped half of a compile that declares no grouped join and has no one
 * host column to key one by: a whole ordered set over a composite primary key
 * (`./compile-alias`), which reads its base table alone.
 */
export const NO_GROUPED: GroupedPlan = Object.freeze({
  aliases: [],
  refs: new Map(),
  ctes: () => [],
  recursive: false,
  outerJoins: () => [],
  routes: [],
  uses: new Map(),
  derivedReads: [],
  rollups: [],
});

/** The ISO-8601 `Z` text a `Date` crosses the JSON wire as, rendered by Postgres. */
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * Compile a collection's children and closure joins (see the header), against
 * the plan that registered their internal relations (`groupedRelationsOf` →
 * `compileAllJoins`). Every misuse throws here, at module eval: an ancestor
 * that is not a base row, a key column of another type, a `fk` / `child` /
 * `parent` leading no index (A37), an aggregate reading a relation outside its
 * join, a `jsonAgg` column outside A39's types or with a wire codec, a nested
 * rollup hop no source covers (A35).
 */
export function compileGrouped(
  specs: readonly GroupedJoinSpec[],
  ctx: {
    plan: JoinPlan;
    base: RoutedBase;
    hostPk: PgColumn;
    relations: ReadonlyMap<string, PgTable>;
    db: QueryDb;
    label: string;
    fail: Fail;
  },
): GroupedPlan {
  const { plan, base, hostPk, relations, fail } = ctx;
  const hostType = canonicalSqlType(hostPk.getSQLType());

  // ── Rendering internal relations ─────────────────────────────────────────
  const aliased = new Map<string, PgTable>();
  const tableOfRel = (rel: string): PgTable =>
    relations.get(rel) ?? fail(`"${rel}" is not a grouped relation.`);
  const renderedTable = (rel: string): PgTable => {
    let t = aliased.get(rel);
    if (t === undefined) {
      t = aliasTable(tableOfRel(rel), rel) as PgTable;
      aliased.set(rel, t);
    }
    return t;
  };
  const renderedCols = new Map<string, PgColumn>();
  const keyOf = (table: PgTable, col: PgColumn): string | undefined =>
    Object.entries(getTableColumns(table) as Record<string, PgColumn>).find(
      ([, c]) => c === col,
    )?.[0];
  const render = (rel: string, col: PgColumn): PgColumn => {
    const table = tableOfRel(rel);
    const key =
      keyOf(table, col) ??
      fail(
        `column "${col.name}" is not a column of "${getTableName(table)}" (relation "${rel}").`,
      );
    const cacheKey = `${rel}\u0000${key}`;
    let out = renderedCols.get(cacheKey);
    if (out === undefined) {
      out = (renderedTable(rel) as unknown as Record<string, PgColumn>)[key]!;
      renderedCols.set(cacheKey, out);
    }
    return out;
  };
  const refsOf = (rel: string): Record<string, InternalColumnRef> =>
    Object.fromEntries(
      Object.entries(
        getTableColumns(tableOfRel(rel)) as Record<string, PgColumn>,
      ).map(([k, col]) => [
        k,
        {
          from: rel,
          col,
          getSQL: (): SQL => sql`${render(rel, col)}`,
          shouldOmitSQLParens: () => true,
        } as InternalColumnRef,
      ]),
    );
  const renderRef = (ref: TypedColumnRef<string, PgColumn>): PgColumn =>
    render(ref.from, ref.col);

  // ── Checks ───────────────────────────────────────────────────────────────
  const assertLeadsIndex = (table: PgTable, col: PgColumn, what: string) => {
    if (!leadsIndex(table, col)) {
      fail(
        `${what} "${getTableName(table)}"."${col.name}" leads no index and is not the primary key's first column (A37) — every grouped CTE and probe looks rows up by it. Declare an index on it.`,
      );
    }
  };
  const assertType = (col: PgColumn, what: string): void => {
    if (canonicalSqlType(col.getSQLType()) !== hostType) {
      fail(
        `${what} "${col.name}" is ${col.getSQLType()}, but the host's identity "${hostPk.name}" is ${hostPk.getSQLType()} — it holds a host id, so it has the host id's type.`,
      );
    }
  };
  const assertWithin = (
    where: string,
    fragment: SQL,
    allowed: ReadonlySet<string>,
  ): void => {
    for (const [relation, column] of plan.columnsIn(fragment)) {
      if (!allowed.has(relation)) {
        fail(
          `${where} reads "${relation}"."${column}", outside the join (its relations: ${[...allowed].map((r) => `"${r}"`).join(", ")}) — an aggregate is computed per host from its own group.`,
        );
      }
    }
  };

  /**
   * Every declared relation in `declared` is read by `fragments` (a join's
   * where and aggregate bodies) — like the top-level refusal of an unread
   * grouped join: an unread nested rollup or ancestor join would still be
   * joined inside the CTE and its sources routed, probing and refilling on
   * writes that change nothing.
   */
  const assertRead = (
    where: string,
    fragments: readonly SQL[],
    declared: readonly { rel: string; what: string }[],
  ): void => {
    const read = plan.relationsIn(fragments);
    for (const d of declared) {
      if (!read.has(d.rel)) {
        fail(
          `${where}: ${d.what} is declared but neither its where nor any aggregate reads it — it would be joined, and its sources routed, for nothing.`,
        );
      }
    }
  };

  // ── Aggregates ───────────────────────────────────────────────────────────
  const bodyOf = (
    where: string,
    agg: Aggregate,
    pk: readonly PgColumn[],
    allowed: ReadonlySet<string>,
  ): SQL => {
    if (!isAggregate(agg)) {
      fail(
        `${where} is not an aggregate made by \`aggregate\` or \`jsonAgg\`.`,
      );
    }
    if (agg.shape.kind === "expr") {
      const body = sql`(${agg.shape.sql})`;
      assertWithin(where, body, allowed);
      return body;
    }
    const fields = Object.entries(agg.shape.columns).map(([key, ref]) => {
      if (!JSON_KEY_RE.test(key)) {
        fail(
          `${where}: jsonAgg field "${key}" is not ${JSON_KEY_RE.source} — it is rendered as a SQL string literal.`,
        );
      }
      if (!allowed.has(ref.from)) {
        fail(
          `${where}: jsonAgg field "${key}" reads relation "${ref.from}", outside the join.`,
        );
      }
      const type = canonicalSqlType(ref.col.getSQLType());
      if (!JSON_AGG_TYPES.has(type)) {
        fail(
          `${where}: jsonAgg field "${key}" is a ${ref.col.getSQLType()} column — a jsonAgg element carries only ${[...JSON_AGG_TYPES].join(", ")} (A39), whose JSON form the row type states.`,
        );
      }
      if (columnWireCodec(ref.col) !== undefined) {
        fail(
          `${where}: jsonAgg field "${key}" is a wire-encoded column (\`withWire\`) — its JSON form is the codec's, applied in JS, never inside an aggregate (A39).`,
        );
      }
      const col = renderRef(ref);
      const value =
        type === "timestamp with time zone"
          ? sql`to_char(${col} AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)})`
          : sql`${col}`;
      return sql`${sql.raw(`'${key}'`)}, ${value}`;
    });
    const order = [
      ...agg.shape.orderBy.map(([ref, dir]) => {
        if (!allowed.has(ref.from)) {
          fail(
            `${where}: jsonAgg orders by relation "${ref.from}", outside the join.`,
          );
        }
        return sql`${renderRef(ref)} ${sql.raw(dir === "desc" ? "DESC" : "ASC")} NULLS LAST`;
      }),
      ...pk.map((c) => sql`${c} ASC`),
    ];
    return sql`json_agg(json_build_object(${sql.join(fields, sql`, `)}) ORDER BY ${sql.join(order, sql`, `)})`;
  };

  /** The outer read of one aggregate, registered with its provenance. */
  const outerOf = (
    rel: string,
    cte: string,
    a: CompiledAggregate,
    provenance: readonly (PgColumn | SQL)[],
  ): SQL => {
    const out = sql`${sql.raw(cte)}.${sql.identifier(a.name)}`;
    const ifNone =
      a.agg.shape.kind === "json" ? sql.raw(`'[]'::json`) : a.agg.shape.ifNone;
    return plan.renderAggregate(
      ifNone === null ? out : sql`COALESCE(${out}, ${ifNone})`,
      {
        name: a.name,
        relation: rel,
        reads: [a.body, ...provenance],
        nullable: !a.agg.notNull,
        sqlType: a.agg.sqlType,
        decoder: a.agg.decoder,
      },
    );
  };

  const aggregatesOf = (
    where: string,
    set: AggregateSet,
    pk: readonly PgColumn[],
    allowed: ReadonlySet<string>,
  ): CompiledAggregate[] =>
    Object.entries(set).map(([name, agg]) => ({
      name,
      agg,
      body: bodyOf(`${where} aggregate "${name}"`, agg, pk, allowed),
    }));

  // ── Nested rollups ───────────────────────────────────────────────────────
  const nestedRollup = (
    hostRel: string,
    r: NestedRollupJoin,
    where: string,
  ): CompiledNestedRollup => {
    const rel = `${hostRel}__${r.alias}`;
    const handle = r.rollup.handle;
    const keyColumn =
      (Object.values(getTableColumns(handle)) as PgColumn[]).find(
        (c) => c.name === r.rollup.key,
      ) ??
      fail(
        `${where} rollup "${r.alias}": rollup "${r.rollup.table}" has no key column "${r.rollup.key}" on its handle.`,
      );
    if (
      canonicalSqlType(r.on.getSQLType()) !==
      canonicalSqlType(keyColumn.getSQLType())
    ) {
      fail(
        `${where} rollup "${r.alias}": its \`on\` "${r.on.name}" is ${r.on.getSQLType()}, but rollup "${r.rollup.table}"'s key "${keyColumn.name}" is ${keyColumn.getSQLType()} (A4).`,
      );
    }
    assertHopsCovered(r.rollup.sources, (problem) =>
      fail(
        `${where} rollup "${r.alias}": rollup "${r.rollup.table}"'s ${problem} (A35).`,
      ),
    );
    return {
      spec: r,
      rel,
      onOwn: r.on,
      on: sql`${render(rel, keyColumn)} = ${render(hostRel, r.on)}`,
    };
  };

  // ── Children ─────────────────────────────────────────────────────────────
  const compileChildren = (
    rel: string,
    spec: ChildrenJoin,
    keyed: string,
  ): CompiledChildren => {
    const where = `children join "${spec.alias}"${keyed}`;
    assertType(spec.fk, `${where}: its fk`);
    assertLeadsIndex(spec.table, spec.fk, `${where}: its fk`);
    const rollups = spec.rollups.map((r) => nestedRollup(rel, r, where));
    const allowed = new Set([rel, ...rollups.map((r) => r.rel)]);
    const refs: Record<string, unknown> = { [spec.alias]: refsOf(rel) };
    for (const r of rollups) refs[r.spec.alias] = refsOf(r.rel);
    const pred =
      spec.where === undefined
        ? undefined
        : spec.where(refs as Parameters<NonNullable<ChildrenJoin["where"]>>[0]);
    if (pred !== undefined) assertWithin(`${where}'s where`, pred, allowed);
    const pk = ownPrimary(spec.table).map((c) => render(rel, c));
    const aggregates = aggregatesOf(
      where,
      spec.aggregates(refs as Parameters<ChildrenJoin["aggregates"]>[0]),
      pk,
      allowed,
    );
    if (aggregates.length === 0) {
      fail(`${where} declares no aggregate — nothing of it reaches the row.`);
    }
    assertRead(
      where,
      [...(pred ? [pred] : []), ...aggregates.map((a) => a.body)],
      rollups.map((r) => ({ rel: r.rel, what: `rollup "${r.spec.alias}"` })),
    );
    const fk = render(rel, spec.fk);
    const read = new Set<string>([
      spec.fk.name,
      ...pk.map((c) => c.name),
      ...rollups.map((r) => r.onOwn.name),
    ]);
    for (const [relation, column] of plan.columnsIn([
      ...(pred ? [pred] : []),
      ...aggregates.map((a) => a.body),
    ])) {
      if (relation === rel) read.add(column);
    }
    return {
      spec,
      rel,
      cte: `__c_${rel}`,
      table: spec.table,
      fk,
      pk,
      rollups,
      where: pred,
      aggregates,
      gate: tableOrder(spec.table, read),
    };
  };

  // ── Closure ──────────────────────────────────────────────────────────────
  const compileClosure = (spec: ClosureJoin): CompiledClosure => {
    const rel = spec.alias;
    const where = `closure join "${rel}"`;
    if (spec.nodes !== base.table) {
      fail(
        `${where}: its \`nodes\` is "${getTableName(spec.nodes)}", not the base table "${base.name}" — an ancestor is a host row, so a node's aggregate and its own are computed over one table.`,
      );
    }
    assertType(spec.child, `${where}: its child`);
    assertType(spec.parent, `${where}: its parent`);
    assertLeadsIndex(spec.edges, spec.child, `${where}: its child`);
    assertLeadsIndex(spec.edges, spec.parent, `${where}: its parent`);
    const ancRel = `${rel}__anc`;
    const ancRollups: CompiledNestedRollup[] = [];
    const ancChildren: CompiledChildren[] = [];
    for (const j of spec.ancestorJoins) {
      if (j.kind === "rollup") ancRollups.push(nestedRollup(ancRel, j, where));
      else
        ancChildren.push(
          compileChildren(
            `${ancRel}__${j.alias}`,
            j,
            ` (under closure "${rel}")`,
          ),
        );
    }
    const allowed = new Set<string>([ancRel, ...ancRollups.map((r) => r.rel)]);
    for (const c of ancChildren) {
      allowed.add(c.rel);
      for (const r of c.rollups) allowed.add(r.rel);
    }
    const refs: Record<string, unknown> = { anc: refsOf(ancRel) };
    for (const r of ancRollups) refs[r.spec.alias] = refsOf(r.rel);
    for (const c of ancChildren) {
      refs[c.spec.alias] = Object.fromEntries(
        c.aggregates.map((a) => [
          a.name,
          aggregateRef(c.rel, a.name, () => outerOfChildren(c, a)),
        ]),
      );
    }
    const ancPk = render(ancRel, hostPk);
    // A node with no ancestor reads `ifNone`; the pk tiebreaker of a `jsonAgg`
    // over ancestors is the ancestor's own.
    const aggregates = aggregatesOf(
      where,
      spec.aggregates(refs as Parameters<ClosureJoin["aggregates"]>[0]),
      [ancPk],
      allowed,
    );
    if (aggregates.length === 0) {
      fail(`${where} declares no aggregate — nothing of it reaches the row.`);
    }
    assertRead(
      where,
      aggregates.map((a) => a.body),
      [
        ...ancRollups.map((r) => ({
          rel: r.rel,
          what: `ancestor rollup "${r.spec.alias}"`,
        })),
        ...ancChildren.map((c) => ({
          rel: c.rel,
          what: `ancestor children join "${c.spec.alias}"`,
        })),
      ],
    );
    const nodeRead = new Set<string>([
      hostPk.name,
      ...ancRollups.map((r) => r.onOwn.name),
    ]);
    for (const [relation, column] of plan.columnsIn(
      aggregates.map((a) => a.body),
    )) {
      if (relation === ancRel) nodeRead.add(column);
    }
    return {
      spec,
      rel,
      pairs: `__x_${rel}`,
      cte: `__g_${rel}`,
      deps: `__d_${rel}`,
      child: render(rel, spec.child),
      parent: render(rel, spec.parent),
      anc: { rel: ancRel, pk: ancPk },
      ancRollups,
      ancChildren,
      aggregates,
      edgeGate: tableOrder(
        spec.edges,
        new Set([spec.child.name, spec.parent.name]),
      ),
      nodeGate: tableOrder(base.table, nodeRead),
    };
  };

  // One outer read per (children, aggregate), registered once.
  const childrenOuter = new Map<string, SQL>();
  const outerOfChildren = (c: CompiledChildren, a: CompiledAggregate): SQL => {
    const key = `${c.rel}\u0000${a.name}`;
    let out = childrenOuter.get(key);
    if (out === undefined) {
      out = outerOf(c.rel, c.cte, a, [
        c.fk,
        ...(c.where === undefined ? [] : [c.where]),
      ]);
      childrenOuter.set(key, out);
    }
    return out;
  };

  const compiled: CompiledGrouped[] = specs.map((spec) =>
    spec.kind === "children"
      ? { kind: "children", ...compileChildren(spec.alias, spec, "") }
      : { kind: "closure", ...compileClosure(spec) },
  );

  // ── The aggregate refs `j.<alias>` offers ────────────────────────────────
  const refs = new Map<string, Record<string, AggregateRefRuntime>>();
  for (const g of compiled) {
    if (g.kind === "children") {
      refs.set(
        g.rel,
        Object.fromEntries(
          g.aggregates.map((a) => [
            a.name,
            aggregateRef(g.rel, a.name, () => outerOfChildren(g, a)),
          ]),
        ),
      );
      continue;
    }
    const closure = g;
    const outers = new Map<string, SQL>();
    refs.set(
      g.rel,
      Object.fromEntries(
        g.aggregates.map((a) => [
          a.name,
          aggregateRef(g.rel, a.name, () => {
            let out = outers.get(a.name);
            if (out === undefined) {
              out = outerOf(closure.rel, closure.cte, a, [
                closure.child,
                closure.parent,
              ]);
              outers.set(a.name, out);
            }
            return out;
          }),
        ]),
      ),
    );
  }

  // ── CTEs ─────────────────────────────────────────────────────────────────
  const childrenCte = (c: CompiledChildren, filter: SQL | undefined): SQL => {
    const from = [
      sql`${c.table} ${sql.identifier(c.rel)}`,
      ...c.rollups.map(
        (r) =>
          sql`LEFT JOIN ${r.spec.rollup.handle} ${sql.identifier(r.rel)} ON ${r.on}`,
      ),
    ];
    const where = allOf([c.where, filter]);
    const select = [
      sql`${c.fk} AS __k`,
      ...c.aggregates.map((a) => sql`${a.body} AS ${sql.identifier(a.name)}`),
    ];
    return sql`${sql.raw(c.cte)} AS (SELECT ${sql.join(select, sql`, `)} FROM ${sql.join(from, sql` `)}${where ? sql` WHERE ${where}` : sql``} GROUP BY ${c.fk})`;
  };
  const closureCtes = (c: CompiledClosure, scope: GroupedScope): SQL[] => {
    const edges = sql`${c.spec.edges} ${sql.identifier(c.rel)}`;
    const pairs = sql.raw(c.pairs);
    const walk =
      scope.kind === "full"
        ? sql`SELECT ${pairs}.__n, ${c.parent} FROM ${pairs} JOIN ${edges} ON ${c.child} = ${pairs}.__a`
        : // A32: the walk is a lateral per reached node (`OFFSET 0` keeps the
          // planner from flattening it into a hash join over every edge), so
          // a refill of a few hosts reads only their ancestors' edges.
          sql`SELECT ${pairs}.__n, __y.__a FROM ${pairs} CROSS JOIN LATERAL (SELECT ${c.parent} AS __a FROM ${edges} WHERE ${c.child} = ${pairs}.__a OFFSET 0) __y`;
    const seed = sql`SELECT ${c.child} AS __n, ${c.parent} AS __a FROM ${edges}${scope.kind === "scoped" ? sql` WHERE ${scope.hostIn(c.child)}` : sql``}`;
    const out: SQL[] = [sql`${pairs} AS (${seed} UNION ${walk})`];
    // The ancestors' own groups: every group (full), or — A32 — only the
    // reached ancestors', named once by an InitPlan over the pairs.
    for (const ch of c.ancChildren) {
      out.push(
        childrenCte(
          ch,
          scope.kind === "full"
            ? undefined
            : sql`${ch.fk} = ANY(ARRAY(SELECT DISTINCT ${pairs}.__a FROM ${pairs}))`,
        ),
      );
    }
    const nodes = sql`${base.table} ${sql.identifier(c.anc.rel)}`;
    const ancestor =
      scope.kind === "full"
        ? sql`JOIN ${nodes} ON ${c.anc.pk} = ${pairs}.__a`
        : // A32: the ancestor row by its pk, one lateral lookup per pair.
          sql`CROSS JOIN LATERAL (SELECT * FROM ${nodes} WHERE ${c.anc.pk} = ${pairs}.__a OFFSET 0) ${sql.identifier(c.anc.rel)}`;
    const joins = [
      ancestor,
      ...c.ancRollups.map(
        (r) =>
          sql`LEFT JOIN ${r.spec.rollup.handle} ${sql.identifier(r.rel)} ON ${r.on}`,
      ),
      ...c.ancChildren.map(
        (ch) =>
          sql`LEFT JOIN ${sql.raw(ch.cte)} ON ${sql.raw(ch.cte)}.__k = ${c.anc.pk}`,
      ),
    ];
    const select = [
      sql`${pairs}.__n AS __k`,
      ...c.aggregates.map((a) => sql`${a.body} AS ${sql.identifier(a.name)}`),
    ];
    out.push(
      sql`${sql.raw(c.cte)} AS (SELECT ${sql.join(select, sql`, `)} FROM ${pairs} ${sql.join(joins, sql` `)} GROUP BY ${pairs}.__n)`,
    );
    return out;
  };

  // ── Routes ───────────────────────────────────────────────────────────────
  const db = ctx.db;
  const keyedBy = (table: PgTable, col: PgColumn): { column?: string } =>
    tablePrimary(table) === col ? {} : { column: col.name };
  const srcGate = (src: CompiledRollupSource): string[] =>
    [...new Set([...src.pk, src.carry, ...src.reads])].sort();
  /** `<on> = ANY(<keys>)` — the carried values as rollup keys, through `via`. */
  const inKeys = (
    on: PgColumn,
    src: CompiledRollupSource,
    changed: readonly string[],
  ): SQL =>
    src.via === undefined
      ? anyOf(on, changed, { invalid: "throws" })
      : sql`${on} IN (SELECT ${sql.identifier(src.via.key)} FROM ${sql.identifier(src.via.table)} WHERE ${sql.identifier(src.via.match)} = ANY(${sql.param([...changed])}::${sql.raw(src.carryType)}[]))`;
  type Resolve = (
    changed: readonly string[],
    within: ReadonlySet<string> | null,
    cap: number,
  ) => Promise<readonly string[] | "over-cap">;
  /** Nothing changed, or no host could be kept: no probe. */
  const guarded =
    (resolve: Resolve): Resolve =>
    async (changed, within, cap) =>
      changed.length === 0 || (within !== null && within.size === 0)
        ? []
        : resolve(changed, within, cap);
  /**
   * A rollup source's route: a reverse probe over its carried values, or
   * `full` when the probe would read, after commit, the very table the change
   * is on — its own via hop, or a table the hosts are resolved through (A10).
   */
  const sourceRoute = (
    id: string,
    src: CompiledRollupSource,
    through: readonly string[],
    resolve: Resolve,
  ): RawRoute => {
    const route = { id, table: src.table, columns: srcGate(src) };
    const preImage =
      src.via?.table === src.table
        ? "its own via hop"
        : through.includes(src.table)
          ? `"${src.table}" itself, which the hosts are resolved through`
          : undefined;
    if (preImage !== undefined) {
      return {
        ...route,
        map: {
          kind: "full",
          reason: `pre-image needed: rollup source "${src.table}" (route "${id}") is resolved through ${preImage} — read after commit, the probe would see the rows that changed, not the ones they were (A10)`,
        },
      };
    }
    return {
      ...route,
      map: {
        kind: "reverse",
        ...(src.pk.length === 1 && src.pk[0] === src.carry
          ? {}
          : { column: src.carry }),
        resolve: guarded(resolve),
      },
    };
  };
  /** The distinct host ids `hostCol` holds in `from WHERE pred`, `within`-bounded, cap + 1. */
  const probe = async (
    label: string,
    hostCol: PgColumn,
    from: SQL,
    pred: SQL,
    within: ReadonlySet<string> | null,
    cap: number,
  ): Promise<readonly string[] | "over-cap"> => {
    const where = allOf([
      pred,
      within === null
        ? undefined
        : anyOf(hostCol, [...within], { invalid: "absent" }),
    ]);
    const rows = await executeRows(db, {
      query: sql`SELECT DISTINCT ${hostCol} AS __h FROM ${from} WHERE ${where} LIMIT ${cap + 1}`,
      row: decodedRow({ __h: String }),
      label,
    });
    return rows.length > cap ? "over-cap" : rows.map((r) => r.__h);
  };
  /**
   * The dependents probe: every node with an ancestor `seed` names (a
   * predicate over the edge's `parent`) — the walk runs DOWN the edges, one
   * `OFFSET 0` lateral index probe per reached node (A32). `within` goes into
   * the SQL only up to `WITHIN_IN_SQL_MAX` ids; past it, it is filtered here
   * (the cap then counts unfiltered dependents: over-cap is reported sooner,
   * never later).
   */
  const dependents = async (
    c: CompiledClosure,
    label: string,
    seed: SQL,
    within: ReadonlySet<string> | null,
    cap: number,
  ): Promise<readonly string[] | "over-cap"> => {
    const d = sql.raw(c.deps);
    const edges = sql`${c.spec.edges} ${sql.identifier(c.rel)}`;
    const inSql = within !== null && within.size <= WITHIN_IN_SQL_MAX;
    const bound = inSql
      ? sql` WHERE ${anyOfExpr(sql`${d}.__n`, hostPk.getSQLType(), [...within], { invalid: "absent" })}`
      : sql``;
    const rows = await executeRows(db, {
      query: sql`WITH RECURSIVE ${d} AS (SELECT ${c.child} AS __n FROM ${edges} WHERE ${seed} UNION SELECT __y.__n FROM ${d} CROSS JOIN LATERAL (SELECT ${c.child} AS __n FROM ${edges} WHERE ${c.parent} = ${d}.__n OFFSET 0) __y) SELECT ${d}.__n AS __n FROM ${d}${bound} LIMIT ${cap + 1}`,
      row: decodedRow({ __n: String }),
      label,
    });
    if (rows.length > cap) return "over-cap";
    const hosts = rows.map((r) => r.__n);
    return within === null || inSql
      ? hosts
      : hosts.filter((h) => within.has(h));
  };

  const routes: RawRoute[] = [];
  /**
   * A children join's routes: its own table (`map`: an alias on `fk` at the
   * top level, whose values ARE host ids; under a closure, the reverse that
   * expands them to dependents), and each nested rollup's sources, resolved
   * through the child rows whose `on` names a moved key.
   */
  const childrenRoutes = (
    c: CompiledChildren,
    idOf: (id: string) => string,
    own: RawRoute["map"],
    /** The hosts the child rows matching `childWhere` (a predicate over `c.rel`) reach. */
    hostsOfChildren: (
      label: string,
      childWhere: SQL,
      within: ReadonlySet<string> | null,
      cap: number,
    ) => Promise<readonly string[] | "over-cap">,
    through: readonly string[],
  ): void => {
    const table = getTableName(c.table);
    routes.push({ id: idOf(c.rel), table, columns: c.gate, map: own });
    for (const r of c.rollups) {
      const childOn = render(c.rel, r.onOwn);
      for (const src of r.spec.rollup.sources) {
        const id = idOf(rollupRouteId(r.rel, src.table));
        routes.push(
          sourceRoute(id, src, [table, ...through], (changed, within, cap) =>
            hostsOfChildren(id, inKeys(childOn, src, changed), within, cap),
          ),
        );
      }
    }
  };

  for (const g of compiled) {
    if (g.kind === "children") {
      childrenRoutes(
        g,
        (id) => id,
        { kind: "alias", ...keyedBy(g.table, g.spec.fk) },
        (label, childWhere, within, cap) =>
          probe(
            label,
            g.fk,
            sql`${g.table} ${sql.identifier(g.rel)}`,
            childWhere,
            within,
            cap,
          ),
        [],
      );
      continue;
    }
    const c = g;
    const edgeTable = getTableName(c.spec.edges);
    const closureId = (id: string): string => `${id}:closure`;
    const parentIn = (values: readonly string[]): SQL =>
      anyOf(c.parent, values, { invalid: "throws" });
    const expand: Resolve = (changed, within, cap) =>
      dependents(c, closureId(c.rel), parentIn(changed), within, cap);
    // `<a>`: an edge write moves its child's own ancestor set …
    routes.push({
      id: c.rel,
      table: edgeTable,
      columns: c.edgeGate,
      map: { kind: "alias", ...keyedBy(c.spec.edges, c.spec.child) },
    });
    // … and `<a>:closure` the ancestor set of every node below that child.
    routes.push({
      id: closureId(c.rel),
      table: edgeTable,
      columns: c.edgeGate,
      map: {
        kind: "reverse",
        ...keyedBy(c.spec.edges, c.spec.child),
        resolve: guarded(expand),
      },
    });
    // `<a>__anc:closure`: a node's columns its dependents' aggregates read.
    routes.push({
      id: closureId(c.anc.rel),
      table: base.name,
      columns: c.nodeGate,
      map: {
        kind: "reverse",
        ...keyedBy(base.table, hostPk),
        resolve: guarded((changed, within, cap) =>
          dependents(c, closureId(c.anc.rel), parentIn(changed), within, cap),
        ),
      },
    });
    const through = [edgeTable, base.name];
    const nodes = sql`${base.table} ${sql.identifier(c.anc.rel)}`;
    for (const r of c.ancRollups) {
      const ancOn = render(c.anc.rel, r.onOwn);
      for (const src of r.spec.rollup.sources) {
        const id = closureId(rollupRouteId(r.rel, src.table));
        routes.push(
          sourceRoute(id, src, through, (changed, within, cap) =>
            dependents(
              c,
              id,
              sql`${c.parent} IN (SELECT ${c.anc.pk} FROM ${nodes} WHERE ${inKeys(ancOn, src, changed)})`,
              within,
              cap,
            ),
          ),
        );
      }
    }
    for (const ch of c.ancChildren) {
      const children = sql`${ch.table} ${sql.identifier(ch.rel)}`;
      childrenRoutes(
        ch,
        closureId,
        {
          kind: "reverse",
          ...keyedBy(ch.table, ch.spec.fk),
          resolve: guarded((changed, within, cap) =>
            dependents(c, closureId(ch.rel), parentIn(changed), within, cap),
          ),
        },
        (label, childWhere, within, cap) =>
          dependents(
            c,
            label,
            sql`${c.parent} IN (SELECT ${ch.fk} FROM ${children} WHERE ${childWhere})`,
            within,
            cap,
          ),
        through,
      );
    }
  }

  // ── Derived reads ────────────────────────────────────────────────────────
  const rollups = new Map<string, Rollup>();
  const addRollups = (rs: readonly CompiledNestedRollup[]) => {
    for (const r of rs) rollups.set(r.spec.rollup.table, r.spec.rollup);
  };
  for (const g of compiled) {
    if (g.kind === "children") addRollups(g.rollups);
    else {
      addRollups(g.ancRollups);
      for (const ch of g.ancChildren) addRollups(ch.rollups);
    }
  }

  return {
    aliases: compiled.map((g) => g.rel),
    refs,
    recursive: compiled.some((g) => g.kind === "closure"),
    ctes: (scope) =>
      compiled.flatMap((g) =>
        g.kind === "children"
          ? [
              childrenCte(
                g,
                scope.kind === "full" ? undefined : scope.hostIn(g.fk),
              ),
            ]
          : closureCtes(g, scope),
      ),
    outerJoins: (pk) =>
      compiled.map(
        (g) =>
          sql`LEFT JOIN ${sql.raw(g.cte)} ON ${sql.raw(g.cte)}.__k = ${pk}`,
      ),
    routes,
    uses: new Map(routes.map((r) => [r.id, VALUE])),
    derivedReads: [...rollups.values()].map((r) => ({
      table: r.table,
      sources: r.sources.map((s) => s.table),
    })),
    rollups: [...rollups.values()],
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** An aggregate ref the compiler hands out: renders as its outer read, rendered on first use. */
function aggregateRef(
  from: string,
  aggregate: string,
  outer: () => SQL,
): AggregateRefRuntime {
  return {
    from,
    aggregate,
    getSQL: () => outer(),
    shouldOmitSQLParens: () => true,
  } as AggregateRefRuntime;
}

/** A table's primary-key columns, as the table's OWN column objects. */
function ownPrimary(table: PgTable): PgColumn[] {
  const names = primaryColumns(table).map((c) => c.name);
  const own = Object.values(getTableColumns(table) as Record<string, PgColumn>);
  return names.map((n) => own.find((c) => c.name === n)!);
}

/**
 * A37: whether `col` leads a declared index, a unique constraint, or the
 * primary key of `table` — so a lookup by it (a grouped CTE restricted to some
 * hosts, a probe) is an index scan, not a sequential one.
 */
function leadsIndex(table: PgTable, col: PgColumn): boolean {
  if (primaryColumns(table)[0]?.name === col.name) return true;
  if (col.isUnique) return true;
  const config = getTableConfig(table);
  for (const idx of config.indexes) {
    // An index's columns are drizzle `IndexedColumn`s (or SQL): by name.
    const first = idx.config.columns[0] as { name?: unknown } | undefined;
    if (!is(first, SQL) && first?.name === col.name) return true;
  }
  for (const u of config.uniqueConstraints) {
    if (u.columns[0]?.name === col.name) return true;
  }
  return false;
}

/** The columns of `table` named in `names`, in the table's own order. */
function tableOrder(table: PgTable, names: ReadonlySet<string>): string[] {
  return Object.values(getTableColumns(table) as Record<string, PgColumn>)
    .map((c) => c.name)
    .filter((n) => names.has(n));
}
