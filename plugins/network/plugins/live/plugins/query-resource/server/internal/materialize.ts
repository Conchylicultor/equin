import { getTableColumns, getTableName, sql, type SQL } from "drizzle-orm";
import { PgDialect, type PgColumn, type PgTable } from "drizzle-orm/pg-core";
import {
  defineRollup,
  type Rollup,
  type RollupSourceSpec,
} from "@plugins/database/plugins/derived-tables/core";
import type {
  ChildrenJoin,
  ClosureJoin,
  ExtensionJoin,
} from "@plugins/network/plugins/live/plugins/query-resource/core";
import { compileAllJoins } from "./joins";
import { compileGrouped, groupedRelationsOf } from "./grouped";
import { canonicalSqlType } from "./raw-sql";
import { routedBase, tablePrimary } from "./routes";
import type { QueryDb } from "./spec";

// A MATERIALIZED aggregate join: a children or closure join (the `all`
// compiler's grouped kinds) stored as a derived-tables rollup keyed by the
// host's id, so any compile — a window, a grouping, a count, `:rows`, an `all`
// set — reads its aggregates as plain columns of a 1:1 side table, and can
// filter, sort and group by them.
//
// One declaration, three readers that cannot disagree:
//
//  - the rollup's `select` is the `all` compiler's own grouped CTEs
//    (`compileGrouped`, in its SCOPED shape) projected to one row per host
//    that has a group, each aggregate stored as its outer read (COALESCEd
//    with its `ifNone`) — byte-for-byte what an `all` set reading the join
//    unmaterialized computes;
//  - its sources are read off the join: the child table by `fk`, a nested
//    rollup by its own table (a rollup ON a rollup: its trigger fires only
//    when that aggregate really changed, and after it did), the closure's
//    edges, nodes and ancestor joins with the closure's key expansion — so a
//    prerequisite's change re-aggregates every transitive dependent;
//  - `join()` is an `ExtensionJoin` over the rollup table whose `absent` is
//    each aggregate's `ifNone`: a host with no group reads what it would read
//    unmaterialized.
//
// The table is the caller's drizzle READ handle (a `pgTable(<CONST>, …)` in a
// non-glob file, its name an IMPERATIVE_PUBLIC_TABLES constant — the rollup
// convention): one primary-key column holding the host id, then one column per
// aggregate, by property name, of the aggregate's SQL type, NOT NULL exactly
// when the aggregate never reads NULL. Asserted here at module eval, so the
// handle a reader is typed by and the aggregates the rollup stores cannot
// disagree.
//
// The rollup is `fed` — on the change feed — so a reader is routed by the
// rollup's own rows (a row I / U / D is a host U, the extension route), and
// hears of a host exactly when a stored value changed (the maintain
// function's guarded upsert writes nothing otherwise). That is what lets a
// WINDOW filtered on an aggregate stay exact: a membership move is a write to
// the side row, wherever in the closure it started.

/** A grouped join, materialized into the rollup table `T`. */
export interface MaterializedJoin<
  A extends string = string,
  T extends PgTable = PgTable,
  J extends GroupedJoin = GroupedJoin,
> {
  readonly alias: A;
  /**
   * The grouped join it materializes, as declared — for a reader that must
   * check WHAT is aggregated, not only read it (network/live's tree
   * `childCount`: a children join over the served table by its parent
   * column). Never compiled again from here.
   */
  readonly source: J;
  /** The rollup to contribute: `DerivedTable(m.rollup)`. */
  readonly rollup: Rollup<T>;
  /** The join any compile reads the stored aggregates through (`j.<alias>.<aggregate>`). */
  join(): ExtensionJoin<A, T>;
}

/** The join kinds a `MaterializedJoin` stores. */
export type GroupedJoin = ChildrenJoin | ClosureJoin;

const SCOPE_OPEN = "/*<rollup-scope>*/";
const SCOPE_CLOSE = "/*</rollup-scope>*/";
const SCOPE_RE = /\/\*<rollup-scope>\*\/(.*?)\/\*<\/rollup-scope>\*\//gs;
/**
 * Materialize a children or closure join of `host` into the rollup `table` (a
 * read handle as the header describes). Contribute
 * `DerivedTable(m.rollup)` from the plugin's server definition, and read it
 * with `joins: [m.join()]` in any collection over `host`.
 *
 * Throws at module eval on everything the `all` compiler refuses for the join
 * (unindexed keys, an aggregate reading outside its join, a nested rollup hop
 * no source covers, …), on a host without a single-column primary key, on a
 * table whose columns are not the aggregates, and on a parameter drizzle
 * cannot inline.
 */
export function materializeJoin<J extends GroupedJoin, T extends PgTable>(
  join: J,
  opts: { host: PgTable; table: T },
): MaterializedJoin<J["alias"], T, J> {
  type A = J["alias"];
  const label = `materializeJoin("${join.alias}" → ${getTableName(opts.table)})`;
  const fail = (message: string): never => {
    throw new Error(`${label}: ${message}`);
  };
  const hostPk =
    tablePrimary(opts.host) ??
    fail(
      `the host "${getTableName(opts.host)}" has no single-column primary key.`,
    );

  // ── The join, compiled exactly as the `all` compiler compiles it ─────────
  const base = routedBase(opts.host, label);
  const relations = groupedRelationsOf([join], fail);
  const plan = compileAllJoins(base, [], hostPk, label, relations);
  const neverRoutes = new Proxy(
    {},
    {
      get: () =>
        fail(
          "its routes are never resolved — readers route by the rollup's own rows.",
        ),
    },
  ) as QueryDb;
  const grouped = compileGrouped([join], {
    plan,
    base,
    hostPk,
    relations,
    db: neverRoutes,
    label,
    fail,
  });
  const compiled =
    grouped.joins.get(join.alias) ?? fail("the join compiled to no CTE.");

  // ── The table: the handle, checked against the aggregates ──────────────
  const table = opts.table;
  const tableCols = getTableColumns(table) as Record<string, PgColumn>;
  const keyProps = Object.keys(tableCols).filter((k) => tableCols[k]!.primary);
  if (keyProps.length !== 1) {
    fail(
      `the table needs exactly one primary-key column (the host id); it has ${keyProps.length}.`,
    );
  }
  const keyCol = tableCols[keyProps[0]!]!;
  if (
    canonicalSqlType(keyCol.getSQLType()) !==
    canonicalSqlType(hostPk.getSQLType())
  ) {
    fail(
      `its key "${keyCol.name}" is ${keyCol.getSQLType()}, the host id "${hostPk.name}" is ${hostPk.getSQLType()}.`,
    );
  }
  const stored = compiled.aggregates.map(({ name, agg }) => {
    const ifNone =
      agg.shape.kind === "json" ? sql.raw(`'[]'::json`) : agg.shape.ifNone;
    const col =
      tableCols[name] ??
      fail(`it has no column for aggregate "${name}" (by property name).`);
    if (canonicalSqlType(col.getSQLType()) !== canonicalSqlType(agg.sqlType)) {
      fail(
        `column "${name}" is ${col.getSQLType()}, the aggregate is ${agg.sqlType}.`,
      );
    }
    if (col.notNull !== (ifNone !== null)) {
      fail(
        `column "${name}" is ${col.notNull ? "NOT NULL" : "nullable"}, but the aggregate ${ifNone === null ? "may read NULL (no `ifNone`)" : "never reads NULL (it has an `ifNone`)"}.`,
      );
    }
    return { name, column: col.name, ifNone };
  });
  for (const prop of Object.keys(tableCols)) {
    if (prop !== keyProps[0] && !stored.some((s) => s.name === prop)) {
      fail(`its column "${prop}" is no aggregate of the join.`);
    }
  }

  // ── The select: the scoped CTEs, one row per host with a group ───────────
  const cte = sql.raw(compiled.cte);
  const query = sql`WITH RECURSIVE ${sql.join(
    grouped.ctes({
      kind: "scoped",
      hostIn: (col) => sql`${sql.raw(SCOPE_OPEN)}${col}${sql.raw(SCOPE_CLOSE)}`,
    }),
    sql`, `,
  )} SELECT ${sql.join(
    [
      sql`${cte}.__k AS ${sql.identifier(keyCol.name)}`,
      ...stored.map((s) => {
        const out = sql`${cte}.${sql.identifier(s.name)}`;
        return sql`${s.ifNone === null ? out : sql`COALESCE(${out}, ${s.ifNone})`} AS ${sql.identifier(s.column)}`;
      }),
    ],
    sql`, `,
    // A group whose key is NULL — the children with no host, e.g. a
    // self-referencing tree's ROOTS (`parent IS NULL`) — is no host's: the
    // `all` compiler's LEFT JOIN on `__k` never matches it, so the rollup
    // stores none (a NULL key could only read as drift on every reconcile).
  )} FROM ${cte} WHERE ${cte}.__k IS NOT NULL`;
  // Plain SQL text (a maintain function's body, a temp view), never a
  // prepared statement: every parameter inlined by drizzle's own escaping.
  const rendered = new PgDialect().sqlToQuery(query.inlineParams());
  if (rendered.params.length > 0) {
    fail(
      `its SQL kept ${rendered.params.length} parameter(s) drizzle could not inline.`,
    );
  }
  const text = rendered.sql;
  if (!text.includes(SCOPE_OPEN)) fail("the CTEs never scoped the hosts.");

  // ── The sources ──────────────────────────────────────────────────────────
  // The columns each table's route reads (the compile's gates): what an
  // UPDATE of that table must have moved to re-aggregate.
  const gates = new Map<string, Set<string>>();
  for (const r of grouped.routes) {
    const set = gates.get(r.table) ?? new Set<string>();
    for (const c of r.columns) set.add(c);
    gates.set(r.table, set);
  }
  const readsOf = (t: PgTable, carry: PgColumn): PgColumn[] => {
    const names = gates.get(getTableName(t)) ?? new Set<string>();
    return Object.values(getTableColumns(t) as Record<string, PgColumn>).filter(
      (c) => c !== carry && names.has(c.name),
    );
  };
  const rollupSource = (
    r: Rollup,
    on: PgColumn,
    hop: { table: PgTable; key: PgColumn },
  ): RollupSourceSpec => {
    const cols = getTableColumns(r.handle) as Record<string, PgColumn>;
    const key = Object.values(cols).find((c) => c.name === r.key)!;
    const reads = Object.values(cols).filter((c) => c !== key);
    return on === hop.key
      ? { table: r.handle, carry: key, reads }
      : {
          table: r.handle,
          carry: key,
          via: { table: hop.table, match: on, key: hop.key },
          reads,
        };
  };
  const childrenSources = (c: ChildrenJoin): RollupSourceSpec[] => [
    { table: c.table, carry: c.fk, reads: readsOf(c.table, c.fk) },
    ...c.rollups.map((r) =>
      rollupSource(r.rollup, r.on, { table: c.table, key: c.fk }),
    ),
  ];
  const sources: RollupSourceSpec[] =
    join.kind === "children"
      ? childrenSources(join)
      : [
          {
            table: join.edges,
            carry: join.child,
            reads: readsOf(join.edges, join.child),
          },
          {
            table: opts.host,
            carry: hostPk,
            reads: readsOf(opts.host, hostPk),
          },
          ...join.ancestorJoins.flatMap((a) =>
            a.kind === "children"
              ? childrenSources(a)
              : [
                  rollupSource(a.rollup, a.on, {
                    table: opts.host,
                    key: hostPk,
                  }),
                ],
          ),
        ];

  const rollup = defineRollup({
    table,
    key: keyCol,
    select: (scope) =>
      text.replace(SCOPE_RE, (_, keyExpr: string) => scope(keyExpr)),
    sources,
    ...(join.kind === "closure"
      ? {
          closure: {
            edges: join.edges,
            child: join.child,
            parent: join.parent,
          },
        }
      : {}),
    fed: true,
  });

  const absent = Object.fromEntries(
    stored.map((s) => [s.name, s.ifNone]),
  ) as Record<string, SQL | null>;
  return Object.freeze({
    alias: join.alias as A,
    source: join,
    rollup,
    join: (): ExtensionJoin<A, T> => ({
      kind: "extension",
      alias: join.alias as A,
      table,
      key: keyCol,
      parentKey: hostPk,
      absent,
    }),
  });
}
