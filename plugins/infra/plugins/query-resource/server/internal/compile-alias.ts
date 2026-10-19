import {
  eq,
  getTableColumns,
  is,
  sql,
  SQL,
  type SQLWrapper,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { db as realDb, quotedRelationsIn } from "@plugins/database/server";
import {
  decodedRow,
  nullable,
  type SqlDecoderLike,
} from "@plugins/database/plugins/sql-projection/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { columnSchema } from "@plugins/database/plugins/sql-column/server";
import type {
  DerivedRead,
  KeyedServerResourceOptions,
  ResourceParams,
  ScopePolicy,
  TupleUse,
} from "@plugins/framework/plugins/resource-runtime/core";
import type { PointParams } from "@plugins/primitives/plugins/live-state/core";
import { ResourceContractError } from "@plugins/packages/plugins/resource-protocol/core";
import {
  orderByClauses,
  type SortKey,
} from "@plugins/primitives/plugins/keyset/server";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import {
  BASE_RELATION,
  type AggregateRef,
  type AllJoinRefs,
  type AllJoinSpec,
  type AllQueryParams,
  type AllQueryResourceContract,
  type ColumnRef,
  type ExprField,
  type JoinSpec,
  type PointQueryResourceContract,
  type RollupJoin,
} from "@plugins/infra/plugins/query-resource/core";
import { routedReads } from "./arm-plan";
import {
  decoderId,
  describeZod,
  renderQuery,
  rollupDdlHash,
  sha256,
} from "./fingerprint";
import {
  compileGrouped,
  groupedRelationsOf,
  type GroupedJoinSpec,
  type GroupedScope,
} from "./grouped";
import {
  compileAllJoins,
  joinRefs,
  sameColumn,
  type JoinPlan,
  type PlannedJoin,
  type ReadColumn,
} from "./joins";
import {
  allOf,
  anyOf,
  canonicalSqlType,
  decoderOfRead,
  fromSql,
  type InvalidIdPolicy,
} from "./raw-sql";
import {
  compiledRoutePlan,
  routedBase,
  tablePrimary,
  type RawRoute,
} from "./routes";
import type {
  EntitySource,
  QueryDb,
  RoutedSource,
  SelectMap,
  WindowOrderKey,
} from "./spec";

// The `all` compiler (P8 v3 §4.1, C2/C3/C5/C7/C18 of
// research/2026-10-06-global-scoped-change-routing-p8-v3.md): a collection
// declared `all` (`liveCollection(key, { all })`) is ONE param-less keyed
// resource holding every row in a declared order, plus its `:rows` point
// sibling. Unlike a window it is never cut by a limit, so it is computed
// SET-AT-A-TIME — the base table, its row-wise joins (extension, lookup —
// required INNER included —, keyed side, rollup), and its grouped joins
// (children, closure) as GROUP BY CTEs hash-joined on the host's identity
// (`./grouped`). Its shapes are raw SQL (`QueryDb.execute` + `decodedRow`),
// never an `ArmMode` (C2); it shares the routed half (`routedReads`) with the
// window and the union.
//
// | Shape     | SQL                                                                      |
// |-----------|--------------------------------------------------------------------------|
// | Full      | `WITH [RECURSIVE] <ctes> SELECT … FROM base <joins> LEFT JOIN <cte> … WHERE where ORDER BY orderBy, pk` |
// | Scoped    | the same CTEs restricted to the hosts (`= ANY($ids)`; the closure walked by a fenced lateral, A32), `pk = ANY($ids)`, no ORDER BY |
// | orderIds  | `SELECT pk FROM base <INNER joins + the joins its where reads> WHERE where ORDER BY orderBy, pk` (A29) |
// | `:rows`   | the Scoped shape over the subscribed ids (an id the pk cannot hold: absent) |
//
// The `all` resource's scope policy is the routed `scopedMembership` alias —
// `orderOf` = orderIds, `orderSignatureOf` read off the wire row's `orderBy`
// fields — so an insert is an entrant (one `orderOf`), a delete or a
// where-flip an exit, an order move one `orderOf`, and any other write a
// one-row refill. It is L2-persisted, so its plan carries the DEFINITION
// (`./fingerprint`, A18 / A40). `:rows` is a point membership over the same
// routes.
//
// A set declared `all: { by }` is PARAM'D: one tuple per scope (`{ pageId }`).
// One loop over `by` emits all three halves of the scope, so they cannot
// disagree: the SQL's `col = $param` (ANDed into the full, scoped and
// orderIds shapes), the base identity route's declared `match` columns (the
// change feed carries them as keys) and each tuple's base use's
// `match: { col: {param} }` (plus `moves`: a re-scoped row exits one tuple
// and enters another). The router then skips every tuple of another scope
// before any load. A scope column is a base column of text, uuid or integer
// type, and the server's params gate admits only the canonical text of its
// type — so `col = $param` holds exactly when the feed's `col::text` equals
// the param. Such a set is never preloaded, so never persisted; its
// definition is computed all the same, over a placeholder param. `:rows`
// stays global (by id), with no match.

/** The wire columns a routed source binds through: an entity's, or a table's own. */
type SourceColumns<T extends RoutedSource> = T extends EntitySource
  ? T["wireColumns"]
  : T extends PgTable
    ? T["_"]["columns"]
    : never;

/**
 * What the projection and the `where` are written with: `j` (the base's and
 * each join's wire columns as `ColumnRef`s, a children or closure join's
 * aggregates as `AggregateRef`s), and how each renders through THIS compile's
 * plan — one plan, so every read the SQL makes is one it knows.
 */
export interface AllBind<
  T extends RoutedSource = RoutedSource,
  J extends readonly AllJoinSpec[] = readonly AllJoinSpec[],
> {
  j: AllJoinRefs<SourceColumns<T>, J>;
  /** The compile's plan (provenance, nullability, `columns()` for a predicate). */
  plan: JoinPlan;
  /** A column ref as the SQL reads it (a defaulted extension column's COALESCE). */
  render(ref: ColumnRef): ReadColumn;
  /** An aggregate ref's read: `COALESCE(<cte>."<name>", <ifNone>)`, provenance registered. */
  aggregate(ref: AggregateRef<string, string, unknown>): SQL;
  /** An expression field, rendered once under its row field's name. */
  expr(field: ExprField, name: string): SQL;
}

/** The declaration `compileAllCollection` compiles (its rows and order come from the contract). */
export interface AllCollectionSpec<
  T extends RoutedSource = RoutedSource,
  J extends readonly AllJoinSpec[] = readonly AllJoinSpec[],
> {
  /** The base table — never a view (A1). Its single-column primary key is the host identity. */
  from: T;
  /** Row-wise joins (extension, lookup, keyed side, rollup) and grouped ones (children, closure). */
  joins?: J;
  /**
   * The projection: every row field → its read, rendered through `bind`
   * (`render` / `aggregate` / `expr`). The contract's `queryPk` field reads
   * the base table's primary key.
   */
  select: (bind: AllBind<T, J>) => SelectMap;
  /**
   * The membership predicate (static): the base and its row-wise joins only —
   * never an aggregate, so the order of entrants (`orderIds`) reads no CTE.
   */
  where?: SQL | ((bind: AllBind<T, J>) => SQL | undefined);
  /**
   * The wire row, derived in JS from every row a loader returns (`encodeRow`),
   * and each wire-encoded field's codec by a stable id (`ids`). One option:
   * `encodeRow` is code the definition cannot read, so the ids are what fold
   * it into the definition (A18) — a codec change must change an id.
   */
  wire?: {
    encodeRow: (row: Record<string, unknown>) => Record<string, unknown>;
    ids: Readonly<Record<string, string>>;
  };
  /** How an order field is read off an encoded row (the order signature). Default `row[field]`. */
  readField?: (row: Record<string, unknown>, field: string) => unknown;
  /** Fixed-window trailing debounce (ms) of the `all` resource's flushes (C18). */
  debounceMs?: number;
  /** Test seam. Defaults to the real per-worktree drizzle `db`. */
  db?: QueryDb;
}

/** The two contracts a `liveCollection(key, { all })` mints (`B`: its `by` fields, if scoped). */
export interface AllCollectionContracts<Row, B extends string = never> {
  all: AllQueryResourceContract<Row, B>;
  rows: PointQueryResourceContract<Row>;
}

/** The params the compile reads: none, or a scoped set's `by` values. */
type AllParams = Record<string, string>;

/** The compiled server halves, ready for `defineResource`. */
export interface CompiledAllCollection<
  Row,
  P extends ResourceParams = Record<string, never>,
> {
  all: KeyedServerResourceOptions<Row[], P> & ScopePolicy<P>;
  rows: KeyedServerResourceOptions<Row[], PointParams> &
    ScopePolicy<PointParams>;
  keyField: string;
  /** The L2 definition the `all` plan carries (A18). */
  definition: string;
}

/**
 * Compile a collection declared `all` (see the header). Every misuse throws
 * here, at module eval — the joins' (A4, A35, A37, A38, A39), the projection's
 * (a read of no relation column, C7; an unrendered SQL; an unread grouped
 * join), the order's (a non-base column, A29), the `where`'s (an aggregate),
 * and the SQL's (a quoted relation no route covers; a non-literal param, A40).
 */
export function compileAllCollection<
  Row,
  T extends RoutedSource,
  const J extends readonly AllJoinSpec[] = readonly [],
  B extends string = never,
>(
  contracts: AllCollectionContracts<Row, B>,
  spec: AllCollectionSpec<T, J>,
): CompiledAllCollection<Row, AllQueryParams<B>> {
  // Erased over the scope: the compile reads `by` off the contract at runtime.
  const contract = contracts.all as unknown as
    AllQueryResourceContract<Row> | AllQueryResourceContract<Row, string>;
  const key = contract.key;
  const label = `allCollection("${key}")`;
  const fail = (message: string): never => {
    throw new Error(`${label}: ${message}`);
  };
  if (contracts.rows.key !== `${key}:rows`) {
    fail(
      `the point contract is "${contracts.rows.key}", not "${key}:rows" — both halves are one collection's.`,
    );
  }
  if (contracts.rows.queryPk !== contract.queryPk) {
    fail(
      `the point contract keys on "${contracts.rows.queryPk}", the whole set on "${contract.queryPk}" — one row, one key.`,
    );
  }
  const db: QueryDb = spec.db ?? (realDb as unknown as QueryDb);
  const base = routedBase(spec.from, label);
  const pk =
    tablePrimary(base.table) ??
    fail(
      `the base table "${base.name}" has no single-column primary key — the whole set is keyed by its host identity.`,
    );
  const sourceColumns: Record<string, PgColumn> = isEntitySource(spec.from)
    ? spec.from.wireColumns
    : (getTableColumns(base.table) as Record<string, PgColumn>);

  // ── Joins: row-wise ones planned, grouped ones registered then compiled ───
  const declared: readonly AllJoinSpec[] = spec.joins ?? [];
  const rowWise: PlannedJoin[] = [];
  const groupedSpecs: GroupedJoinSpec[] = [];
  for (const j of declared) {
    if (j.kind === "children" || j.kind === "closure") groupedSpecs.push(j);
    else rowWise.push(j);
  }
  const relations = groupedRelationsOf(groupedSpecs, fail);
  const plan = compileAllJoins(base, rowWise, pk, label, relations);
  const grouped = compileGrouped(groupedSpecs, {
    plan,
    base,
    hostPk: pk,
    relations,
    db,
    label,
    fail,
  });

  // ── `j`, and the projection over it ──────────────────────────────────────
  const windowJoins = rowWise.filter((j): j is JoinSpec => j.kind !== "rollup");
  const j: Record<string, unknown> = {
    ...joinRefs(sourceColumns, windowJoins, plan.render),
  };
  for (const r of rowWise.filter((x): x is RollupJoin => x.kind === "rollup")) {
    j[r.alias] = columnRefs(
      r.alias,
      getTableColumns(r.rollup.handle) as Record<string, PgColumn>,
      plan.render,
    );
  }
  for (const alias of grouped.aliases) j[alias] = grouped.refs.get(alias);
  const bind: AllBind<T, J> = {
    j: j as AllBind<T, J>["j"],
    plan,
    render: (ref) => plan.render(ref),
    aggregate: (ref) => {
      const found = grouped.refs.get(ref.from)?.[ref.aggregate];
      if (found === undefined) {
        return fail(
          `"${ref.from}"."${ref.aggregate}" is no aggregate of a grouped join this collection declares.`,
        );
      }
      return found.getSQL();
    },
    expr: (field, name) =>
      plan.renderExpr(field, { name, baseColumns: sourceColumns }),
  };
  const select = spec.select(bind);
  const where =
    typeof spec.where === "function" ? spec.where(bind) : spec.where;

  const fields = Object.entries(select).map(([name, read]) => {
    if (is(read, SQL.Aliased)) {
      fail(
        `field "${name}" is an aliased SQL — a field reads a column, an expression or an aggregate, rendered through \`bind\`; the compiler names it.`,
      );
    }
    return { name, read: read as ReadColumn };
  });
  if (fields.length === 0) fail("the projection is empty.");
  for (const f of fields) {
    // C7 / risk 4: a read no relation column stands behind would be reached
    // by no route — silently stale.
    if (plan.columnsIn(f.read).length === 0) {
      fail(
        `field "${f.name}" reads no relation column — no route would reach it, so it would go silently stale (C7). Render it from the base, a join or an aggregate.`,
      );
    }
    for (const [relation, column] of plan.columnsIn(f.read, {
      direct: true,
    })) {
      if (plan.isGrouped(relation)) {
        fail(
          `field "${f.name}" reads "${relation}"."${column}" outside an aggregate — a grouped join's rows reach the row only through the aggregates it declares.`,
        );
      }
    }
    // Every read must be one the plan knows (its SQL type and nullability).
    plan.sqlTypeOf(f.read);
  }
  const keyField = contract.queryPk;
  const keyRead =
    select[keyField] ??
    fail(
      `the key field "${keyField}" is not projected — a row is keyed by it.`,
    );
  if (!sameColumn(keyRead as ReadColumn, pk)) {
    fail(
      `the key field "${keyField}" does not read the base table's primary key "${pk.name}" — the whole set is keyed by its host identity.`,
    );
  }
  if (where !== undefined) {
    for (const [relation, column] of plan.columnsIn(where)) {
      if (plan.isGrouped(relation)) {
        fail(
          `the \`where\` reads "${relation}"."${column}", a grouped join's — membership is decided by the base and its row-wise joins, so the order of entrants (orderIds) reads no CTE (A29).`,
        );
      }
    }
  }
  const read = plan.relationsIn(fields.map((f) => f.read));
  for (const alias of grouped.aliases) {
    if (!read.has(alias)) {
      fail(
        `the grouped join "${alias}" is declared but no field reads an aggregate of it — its CTE would be computed for nothing.`,
      );
    }
  }

  // ── The order (A29: base columns, the pk the tiebreaker) ─────────────────
  const orderReads: ReadColumn[] = [];
  const sortKeys: SortKey[] = contract.all.orderBy.map(([field, dir]) => {
    const r =
      (select[field] as ReadColumn | undefined) ??
      fail(`the order field "${field}" is not projected.`);
    if (plan.isComputed(r) || plan.relationOf(r) !== BASE_RELATION) {
      fail(
        `the order field "${field}" reads no base column — the whole set orders by base columns only, so the order of entrants reads no join (A29).`,
      );
    }
    orderReads.push(r);
    return { fieldId: field, col: r, dir, nullable: plan.canBeNull(r) };
  });
  if (!orderReads.some((r) => sameColumn(r, pk))) {
    sortKeys.push({ fieldId: keyField, col: pk, dir: "asc", nullable: false });
  }
  const orderSql = sql.join(orderByClauses(sortKeys), sql`, `);

  // ── The scope (`all.by`): base columns the feed carries as text ──────────
  const scope = scopeOf(contract.all.by ?? [], select, plan, fail);
  // A tuple's membership predicate: the static `where`, ANDed with its scope
  // (`params` null: none — `:rows` is global, by id).
  const whereOf = (params: AllParams | null): SQL | undefined =>
    params === null || scope.length === 0
      ? where
      : allOf([where, ...scope.map((s) => eq(s.col, params[s.field]))]);

  // ── Routes and uses ──────────────────────────────────────────────────────
  const routed = routedReads<AllParams>({
    label,
    base,
    joins: plan,
    projection: select,
    pk,
    keyField,
    where,
    whereReads: undefined,
    match: scope.map((s) => s.col),
    orderColumns: orderReads,
    orderOf: () =>
      orderReads.map((col, i): WindowOrderKey => ({
        col,
        dir: sortKeys[i]!.dir,
      })),
    db,
  });
  const tuple = routed.tuple({});
  const routes: RawRoute[] = [...routed.routes, ...grouped.routes];
  const ids = new Set<string>();
  for (const r of routes) {
    if (ids.has(r.id)) fail(`two routes are "${r.id}" — a route id names one.`);
    ids.add(r.id);
  }
  const uses: ReadonlyMap<string, TupleUse> = new Map([
    ...tuple.uses,
    ...grouped.uses,
  ]);
  const derived = new Map<string, DerivedRead>();
  for (const d of [...routed.derivedReads, ...grouped.derivedReads]) {
    if (!derived.has(d.table)) derived.set(d.table, d);
  }
  const derivedReads = [...derived.values()];

  // ── SQL ──────────────────────────────────────────────────────────────────
  const rowIncluded = new Set(
    [...tuple.included].filter((r) => !plan.isGrouped(r)),
  );
  const membershipIncluded = plan.closure([
    ...plan.required,
    ...(where === undefined ? [] : plan.relationsIn(where)),
  ]);
  const projection = sql.join(
    fields.map((f) => sql`${f.read} AS ${sql.identifier(f.name)}`),
    sql`, `,
  );
  const withOf = (scope: GroupedScope): SQL => {
    const ctes = grouped.ctes(scope);
    return ctes.length === 0
      ? sql``
      : sql`WITH ${sql.raw(grouped.recursive ? "RECURSIVE " : "")}${sql.join(ctes, sql`, `)} `;
  };
  const fromWith = (): SQL =>
    sql.join(
      [fromSql(base, plan, rowIncluded, label), ...grouped.outerJoins(pk)],
      sql` `,
    );
  const fullSql = (params: AllParams): SQL => {
    const w = whereOf(params);
    const parts = [
      sql`${withOf({ kind: "full" })}SELECT ${projection} FROM ${fromWith()}`,
    ];
    if (w !== undefined) parts.push(sql`WHERE ${w}`);
    parts.push(sql`ORDER BY ${orderSql}`);
    return sql.join(parts, sql` `);
  };
  const scopedSql = (
    hosts: readonly string[],
    invalid: InvalidIdPolicy,
    params: AllParams | null,
  ): SQL => {
    const hostIn = (col: PgColumn): SQL => anyOf(col, hosts, { invalid });
    return sql`${withOf({ kind: "scoped", hostIn })}SELECT ${projection} FROM ${fromWith()} WHERE ${allOf([whereOf(params), hostIn(pk)])}`;
  };
  const orderIdsSql = (params: AllParams): SQL => {
    const w = whereOf(params);
    const parts = [
      sql`SELECT ${pk} AS __id FROM ${fromSql(base, plan, membershipIncluded, label)}`,
    ];
    if (w !== undefined) parts.push(sql`WHERE ${w}`);
    parts.push(sql`ORDER BY ${orderSql}`);
    return sql.join(parts, sql` `);
  };

  // The SQL reads only what the routes reach: every relation a read clause
  // names quoted (what a load's read-set captures) is a route table or a
  // derived read (A1, A8 — the drift guard would otherwise fail the first
  // load). Rendered once each, which also refuses a non-literal param (A40).
  const covered = new Set<string>([
    ...routes.map((r) => r.table),
    ...derivedReads.map((d) => d.table),
  ]);
  // A scoped set's shapes are rendered over a placeholder scope, as the
  // scoped shape is over the placeholder id `$ids`.
  const placeholder: AllParams = Object.fromEntries(
    scope.map((s) => [s.field, `$${s.field}`]),
  );
  const rendered = {
    full: renderQuery(fullSql(placeholder), "the full shape", fail),
    scoped: renderQuery(
      scopedSql(["$ids"], "throws", placeholder),
      "the scoped shape",
      fail,
    ),
    orderIds: renderQuery(orderIdsSql(placeholder), "the orderIds shape", fail),
  };
  for (const [shape, q] of Object.entries(rendered)) {
    for (const relation of quotedRelationsIn(q.sql)) {
      if (!covered.has(relation)) {
        fail(
          `the ${shape} shape reads "${relation}", which no route names and no rollup declares — a change to it would reach no reader (A1 / A8).`,
        );
      }
    }
  }

  // ── Rows ─────────────────────────────────────────────────────────────────
  const decoders: Record<string, SqlDecoderLike> = {};
  for (const f of fields) {
    const dec = decoderOfRead(f.read);
    decoders[f.name] = plan.canBeNull(f.read) ? nullable(dec) : dec;
  }
  const rowParser = decodedRow(decoders) as unknown as ZodParser<
    Record<string, unknown>
  >;
  if (spec.wire !== undefined && Object.keys(spec.wire.ids).length === 0) {
    fail(
      "`wire.ids` is empty — name each wire-encoded field's codec by a stable id, so a change to `encodeRow` moves the definition (A18).",
    );
  }
  const encodeRow = spec.wire?.encodeRow;
  const encode = (row: Record<string, unknown>): Row =>
    (encodeRow ? encodeRow(row) : row) as Row;
  const load = async (query: SQL, shape: string): Promise<Row[]> => {
    const rows = await executeRows(db, {
      query,
      row: rowParser,
      label: `${key}:${shape}`,
    });
    return rows.map(encode);
  };
  const orderOf = async (params: AllParams): Promise<string[]> => {
    const rows = await executeRows(db, {
      query: orderIdsSql(params),
      row: decodedRow({ __id: String }),
      label: `${key}:orderIds`,
    });
    return rows.map((r) => r.__id);
  };
  const readField =
    spec.readField ??
    ((row: Record<string, unknown>, field: string): unknown => row[field]);
  const orderFields = contract.all.orderBy.map(([field]) => field);
  const orderSignatureOf = (row: unknown): string =>
    orderFields
      .map(
        (field) =>
          JSON.stringify(readField(row as Record<string, unknown>, field)) ??
          "undefined",
      )
      .join("\u0000");

  // ── The definition (A18 / A40) ───────────────────────────────────────────
  const definition = sha256(
    JSON.stringify({
      v: 1,
      full: rendered.full,
      scoped: rendered.scoped,
      orderIds: rendered.orderIds,
      keyField,
      orderBy: contract.all.orderBy,
      fields: fields.map((f) => [
        f.name,
        decoderId(decoderOfRead(f.read), `field "${f.name}"`, fail),
        plan.sqlTypeOf(f.read),
        plan.canBeNull(f.read),
      ]),
      row: describeZod(contract.schema),
      wire: spec.wire === undefined ? null : sortedEntries(spec.wire.ids),
      rollups: derivedReads
        .map((d) => d.table)
        .sort()
        .map((table) => [
          table,
          rollupDdlHash(
            grouped.rollups.find((r) => r.table === table) ??
              rollupOf(rowWise, table),
          ),
        ]),
      // Only a scoped set names its scope: every other definition is
      // byte-identical to the one it had before `by` existed.
      ...(scope.length === 0 ? {} : { by: scope.map((s) => s.field) }),
    }),
  );

  // ── The two halves ───────────────────────────────────────────────────────
  const usesOf = (): ReadonlyMap<string, TupleUse> => uses;
  // A scoped tuple reads the base matching its scope, and a write moving a
  // scope column moves it (an exit here, an entrant in the new scope).
  const baseUse = uses.get(BASE_RELATION)!;
  const scopedBase: TupleUse =
    baseUse.moves === undefined
      ? baseUse
      : {
          ...baseUse,
          moves: [
            ...new Set([...baseUse.moves, ...scope.map((s) => s.col.name)]),
          ].sort(),
        };
  const allUsesOf =
    scope.length === 0
      ? usesOf
      : (params: AllParams): ReadonlyMap<string, TupleUse> =>
          new Map([
            ...uses,
            [
              BASE_RELATION,
              {
                ...scopedBase,
                match: Object.fromEntries(
                  scope.map((s) => [s.col.name, new Set([params[s.field]!])]),
                ),
              },
            ],
          ]);
  const allPolicy: ScopePolicy<AllParams> = {
    routes: compiledRoutePlan<AllParams>(
      routes,
      allUsesOf,
      derivedReads,
      definition,
    ),
    scopedMembership: { orderOf, orderSignatureOf },
  };
  const all = {
    loader: (params: AllParams, ctx?: { affectedIds: readonly string[] }) =>
      ctx
        ? load(scopedSql(ctx.affectedIds, "throws", params), "scoped")
        : load(fullSql(params), "full"),
    ...allPolicy,
    ...(spec.debounceMs != null ? { debounceMs: spec.debounceMs } : {}),
    // The server's gate: the descriptor's (exactly the scope's keys), then
    // what only the compile knows — each value the canonical text of its
    // column's type, the one spelling the feed's `col::text` can equal.
    ...(scope.length === 0
      ? {}
      : {
          validateParams: (params: ResourceParams) => {
            contract.validateParams?.(params);
            for (const s of scope) s.check(key, params[s.field]!);
          },
        }),
  } as KeyedServerResourceOptions<Row[], AllParams> & ScopePolicy<AllParams>;

  const point = contracts.rows.point;
  const rowsPolicy: ScopePolicy<PointParams> = {
    routes: compiledRoutePlan<PointParams>(routes, usesOf, derivedReads),
    membership: { kind: "point", idsOf: (params) => point.decode(params) },
  };
  const rows = {
    // The subscribed ids are the client's: one the pk cannot hold is absent.
    loader: async (
      params: PointParams,
      ctx?: { affectedIds: readonly string[] },
    ) => {
      const ids = ctx?.affectedIds ?? point.decode(params);
      return ids.length === 0
        ? []
        : load(scopedSql(ids, "absent", null), "rows");
    },
    ...rowsPolicy,
  } as KeyedServerResourceOptions<Row[], PointParams> &
    ScopePolicy<PointParams>;

  return {
    all: all as unknown as CompiledAllCollection<Row, AllQueryParams<B>>["all"],
    rows,
    keyField,
    definition,
  };
}

/** One field of a scoped set's `by`: its base column, and the canonical-text check of its type. */
interface ScopeField {
  field: string;
  col: PgColumn;
  /** Throws `ResourceContractError` unless `value` is the canonical text of the column's type. */
  check(key: string, value: string): void;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INT_RE = /^(0|-?[1-9][0-9]*)$/;
const INT_BOUNDS: Readonly<Record<string, readonly [bigint, bigint]>> = {
  smallint: [-(2n ** 15n), 2n ** 15n - 1n],
  integer: [-(2n ** 31n), 2n ** 31n - 1n],
  bigint: [-(2n ** 63n), 2n ** 63n - 1n],
};

/**
 * The scope types and what their canonical text is: Postgres's own
 * `col::text` of a value, so a param equal to it is the feed's key exactly
 * (`col = $param` ⇔ `col::text = $param`). Any other type is refused: a
 * timestamp's or a float's text depends on settings and rounding.
 */
function canonicalTextOf(
  sqlType: string,
): ((value: string) => string | null) | null {
  if (/^(text|character varying|varchar)(\(\d+\))?$/.test(sqlType)) {
    return () => null;
  }
  if (sqlType === "uuid") {
    return (v) =>
      UUID_RE.test(v) ? null : "a uuid in canonical form (lower-case hex)";
  }
  const bounds = INT_BOUNDS[sqlType];
  if (bounds !== undefined) {
    return (v) =>
      INT_RE.test(v) && BigInt(v) >= bounds[0] && BigInt(v) <= bounds[1]
        ? null
        : `the canonical decimal text of a ${sqlType}`;
  }
  return null;
}

/**
 * A scoped set's `by`, checked against the compile's plan: each field a
 * projected DIRECT base column (no join, no expression — the change feed
 * carries only the base's own columns as keys) of a scope type.
 */
function scopeOf(
  by: readonly string[],
  select: SelectMap,
  plan: JoinPlan,
  fail: (message: string) => never,
): ScopeField[] {
  return by.map((field) => {
    const read =
      (select[field] as ReadColumn | undefined) ??
      fail(`the scope field "${field}" (\`all.by\`) is not projected.`);
    if (plan.isComputed(read) || plan.relationOf(read) !== BASE_RELATION) {
      fail(
        `the scope field "${field}" (\`all.by\`) reads no base column — a tuple's scope is a base column, which the change feed carries as the key its routes match on.`,
      );
    }
    const col = plan.columnOf(read);
    if (columnSchema(col) !== undefined) {
      fail(
        `the scope field "${field}" (\`all.by\`) is a decoded column (sql-column) — a scope is a plain text, uuid or integer column: its param is bound as the stored text the change feed carries, which a decoder may not round-trip.`,
      );
    }
    const sqlType = canonicalSqlType(plan.sqlTypeOf(read));
    const canonical =
      canonicalTextOf(sqlType) ??
      fail(
        `the scope field "${field}" (\`all.by\`) is a ${sqlType} column — a scope is text, uuid or an integer: the text the change feed carries for it must have one spelling a param can equal.`,
      );
    return {
      field,
      col,
      check: (key, value) => {
        const expected = canonical(value);
        if (expected !== null) {
          throw new ResourceContractError(
            key,
            `allCollection("${key}"): param "${field}" must be ${expected}, got ${JSON.stringify(value)} — the scope matches the column's own text.`,
          );
        }
      },
    };
  });
}

function isEntitySource(from: RoutedSource): from is EntitySource {
  return (from as Partial<EntitySource>).wireColumns !== undefined;
}

/** `ColumnRef`s over `columns` as `relation`, rendering through `render` (like `joinRefs`). */
function columnRefs(
  relation: string,
  columns: Readonly<Record<string, PgColumn>>,
  render: (ref: ColumnRef) => ReadColumn,
): Record<string, ColumnRef & SQLWrapper> {
  return Object.fromEntries(
    Object.entries(columns).map(([k, col]) => {
      const ref = { from: relation, col };
      return [
        k,
        {
          ...ref,
          getSQL: (): SQL => {
            const rendered = render(ref);
            return is(rendered, SQL) ? rendered : sql`${rendered}`;
          },
          shouldOmitSQLParens: () => true,
        },
      ];
    }),
  );
}

function rollupOf(
  rowWise: readonly PlannedJoin[],
  table: string,
): RollupJoin["rollup"] {
  const found = rowWise.find(
    (j): j is RollupJoin => j.kind === "rollup" && j.rollup.table === table,
  );
  if (found === undefined) {
    throw new Error(`rollupOf: no rollup join reads "${table}"`);
  }
  return found.rollup;
}

function sortedEntries(
  record: Readonly<Record<string, string>>,
): [string, string][] {
  return Object.entries(record).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}
