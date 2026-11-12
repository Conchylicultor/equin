import type { z } from "zod";
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
import { isTextPassthrough } from "@plugins/packages/plugins/zod-introspect/core";
import type {
  DerivedRead,
  KeyedServerResourceOptions,
  ResourceParams,
  RoutePlan,
  ScopePolicy,
  TupleUse,
} from "@plugins/network/plugins/live/plugins/resource-runtime/core";
import type { PointParams } from "@plugins/network/plugins/live/plugins/live-state/core";
import { ResourceContractError } from "@plugins/network/plugins/live/plugins/resource-protocol/core";
import {
  orderByClauses,
  type SortKey,
} from "@plugins/primitives/plugins/keyset/server";
import {
  BASE_RELATION,
  isCompositeKey,
  liveReadCode,
  type AggregateRef,
  type AllJoinRefs,
  type AllJoinSpec,
  type AllQueryParams,
  type AllQueryResourceContract,
  type ColumnRef,
  type CompositeKey,
  type ExprField,
  type JoinSpec,
  type PointQueryResourceContract,
  type QueryKey,
  type RollupJoin,
  checkSetBudget,
} from "@plugins/network/plugins/live/plugins/query-resource/core";
import { routedReads } from "./arm-plan";
import { canonicalTextOf, exactIdOf } from "./canonical-text";
import {
  followablePoint,
  followableScope,
  type FollowablePlan,
} from "./follow";
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
  NO_GROUPED,
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
  tupleIn,
  type InvalidIdPolicy,
} from "./raw-sql";
import {
  compiledRoutePlan,
  routedBase,
  tablePrimary,
  tablePrimaryColumns,
  type CompositeIdentity,
  type RawRoute,
} from "./routes";
import type {
  EntitySource,
  QueryDb,
  RoutedSource,
  SelectMap,
  WindowOrderKey,
} from "./spec";

// The `all` compile — this module and everything it loads — is code a
// persisted `all` value depends on beyond its definition (`liveReadCode`): the
// L2 snapshot is refused under another digest of it.
liveReadCode.include(import.meta);

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
//
// A set whose key is COMPOSITE (the contract's `queryPk` a `CompositeKey`,
// declared `id: compositeKey([...])`) is over a table with a composite
// primary key — its fields read the key's columns, in the key's order. Every
// key site derives from the one codec: `orderIds` selects the parts and JS
// composes each id (`encodeParts`), a refill or `:rows` read decodes its ids
// back to tuples (`(c1, …) IN (SELECT * FROM unnest(…))`), and the base
// identity route composes a changed row's id from the parts the change feed
// carries. Such a set reads its base table alone (a join is keyed by one host
// column), and the pk columns, ascending, break order ties. Research:
// research/2026-11-02-global-live-composite-key-collections.md.

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
  /**
   * The base table — never a view (A1). Its primary key is the host
   * identity: a single column, or — a contract keyed by a `CompositeKey` —
   * the composite key the codec's fields read, in its order.
   */
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
  /** The row's key: the key field, or the composite key's codec. */
  keyField: QueryKey;
  /** The L2 definition the `all` plan carries (A18). */
  definition: string;
  /**
   * What a follow copies of each half (`./follow`): `rows` by `{ ids }`
   * unless the key is composite (`null`: an id follow matches one key
   * column), `all` by `{ where }` only for a scoped set (`null` otherwise —
   * a whole unscoped set is no tuple of a computed value's).
   */
  followable: { all: FollowablePlan | null; rows: FollowablePlan | null };
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
      `the point contract keys on ${describeKey(contracts.rows.queryPk)}, the whole set on ${describeKey(contract.queryPk)} — one row, one key.`,
    );
  }
  const db: QueryDb = spec.db ?? (realDb as unknown as QueryDb);
  const base = routedBase(spec.from, label);
  const queryKey: QueryKey = contract.queryPk;
  const composite: CompositeKey | null = isCompositeKey(queryKey)
    ? queryKey
    : null;
  // The host identity: the one pk column, or the composite key's columns.
  const pkColumns = tablePrimaryColumns(base.table);
  const pk: PgColumn | CompositeIdentity =
    composite === null
      ? (tablePrimary(base.table) ??
        fail(
          `the base table "${base.name}" has no single-column primary key${pkColumns.length > 1 ? ` (its key is composite: ${pkColumns.map((c) => `"${c.name}"`).join(", ")}) — declare the collection's id as \`compositeKey([...])\` over its fields` : ""} — the whole set is keyed by its host identity.`,
        ))
      : pkColumns.length === composite.fields.length && pkColumns.length > 1
        ? { columns: pkColumns, key: composite }
        : fail(
            `the id is a composite key over ${composite.fields.length} fields, but the base table "${base.name}"'s primary key is ${pkColumns.length === 0 ? "none" : pkColumns.map((c) => `"${c.name}"`).join(", ")} — a composite id is the table's composite primary key, field for column.`,
          );
  const hostPk: PgColumn | undefined =
    composite === null ? (pk as PgColumn) : undefined;
  if (composite !== null && (spec.joins ?? []).length > 0) {
    fail(
      "a composite-keyed set reads its base table alone — a join is keyed by one host column, and the set has none.",
    );
  }
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
  const plan = compileAllJoins(base, rowWise, hostPk, label, relations);
  const grouped =
    hostPk === undefined
      ? NO_GROUPED
      : compileGrouped(groupedSpecs, {
          plan,
          base,
          hostPk,
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
  // The key's fields, each reading its pk column (a composite key's in the
  // key's order — the order the feed's parts and the codec's agree on).
  const keyFields: readonly string[] =
    composite === null ? [queryKey as string] : composite.fields;
  const keyColumns: readonly PgColumn[] =
    composite === null ? [pk as PgColumn] : pkColumns;
  keyFields.forEach((keyField, i) => {
    const col = keyColumns[i]!;
    const keyRead =
      select[keyField] ??
      fail(
        `the key field "${keyField}" is not projected — a row is keyed by it.`,
      );
    if (!sameColumn(keyRead as ReadColumn, col)) {
      fail(
        composite === null
          ? `the key field "${keyField}" does not read the base table's primary key "${col.name}" — the whole set is keyed by its host identity.`
          : `the key field "${keyField}" (part ${i + 1} of the composite id) does not read the primary key's column "${col.name}" — a composite id is the table's primary key, field for column, in the key's order.`,
      );
    }
  });
  // What the key's parts must be, as text: the canonical `col::text` the
  // change feed carries (a composite part only — a single id is checked by
  // the column's own cast).
  const partChecks =
    composite === null
      ? []
      : pkColumns.map((col) => {
          const sqlType = canonicalSqlType(col.getSQLType());
          return (
            canonicalTextOf(sqlType) ??
            fail(
              `the composite id's column "${col.name}" is ${sqlType} — a key part is text, uuid or an integer: its text must have one spelling the change feed's carried key can equal.`,
            )
          );
        });
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
  // The key breaks ties — each of its columns the order does not name yet.
  keyFields.forEach((fieldId, i) => {
    const col = keyColumns[i]!;
    if (!orderReads.some((r) => sameColumn(r, col))) {
      sortKeys.push({ fieldId, col, dir: "asc", nullable: false });
    }
  });
  const orderSql = sql.join(orderByClauses(sortKeys), sql`, `);
  // A capped set (`all: { max }`) reads one row past its cap, so a set that
  // outgrew it is a loud loader error, never a silently truncated list. The
  // literal is a checked positive integer (the declaration's `checkMax`).
  const max = contract.all.max ?? null;
  if (max !== null && (!Number.isSafeInteger(max) || max < 1)) {
    fail(`\`all.max\` is ${String(max)}, not a positive integer.`);
  }
  const limitSql = max === null ? null : sql.raw(`LIMIT ${max + 1}`);
  /**
   * Refuse a load past the declared cap, naming the key and the cap; report
   * one past a whole set's budget (served all the same). Both shapes that
   * read every row of a tuple run it — `full`, and `orderIds`, which every
   * entrant runs — so a set cannot grow past either unseen.
   */
  const capped = <R>(rows: R[], shape: string, params: AllParams): R[] => {
    if (max !== null && rows.length > max) {
      fail(
        `the ${shape} shape read more than ${max} rows — the set is declared \`all: { max: ${max} }\` and outgrew it: raise the cap with a reason, page it as a window, or declare it whole (\`unbounded: { reason, budget }\`).`,
      );
    }
    checkSetBudget(key, contract.all, params, rows.length);
    return rows;
  };

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
    keyField: keyFields,
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
      [
        fromSql(base, plan, rowIncluded, label),
        ...(hostPk === undefined ? [] : grouped.outerJoins(hostPk)),
      ],
      sql` `,
    );
  const fullSql = (params: AllParams): SQL => {
    const w = whereOf(params);
    const parts = [
      sql`${withOf({ kind: "full" })}SELECT ${projection} FROM ${fromWith()}`,
    ];
    if (w !== undefined) parts.push(sql`WHERE ${w}`);
    parts.push(sql`ORDER BY ${orderSql}`);
    if (limitSql !== null) parts.push(limitSql);
    return sql.join(parts, sql` `);
  };
  // A composite key's host tuples: each id decoded and each part checked
  // against its column's canonical text. A vouched-for id (a route's, the
  // runtime's refill) that fails is a broken invariant — thrown; a client's
  // (`:rows`) names no row — absent.
  const hostTuples = (
    hosts: readonly string[],
    invalid: InvalidIdPolicy,
  ): string[][] => {
    const key = composite!;
    const tuples: string[][] = [];
    for (const id of hosts) {
      const parts = key.decode(id);
      const bad =
        parts === null || parts.some((p, i) => partChecks[i]!(p) !== null);
      if (!bad) tuples.push(parts);
      else if (invalid === "throws") {
        fail(
          `the host id ${JSON.stringify(id)} is no id of this set's composite key — a routed or refilled id is the codec's.`,
        );
      }
    }
    return tuples;
  };
  // The refill / `:rows` shape over `hosts` — `null` when no host can match
  // (every composite id was absent), so the caller reads nothing.
  const scopedSql = (
    hosts: readonly string[],
    invalid: InvalidIdPolicy,
    params: AllParams | null,
  ): SQL | null => {
    if (composite !== null) {
      const tuples = hostTuples(hosts, invalid);
      return tuples.length === 0 ? null : scopedTupleSql(tuples, params);
    }
    const hostIn = (col: PgColumn): SQL => anyOf(col, hosts, { invalid });
    return sql`${withOf({ kind: "scoped", hostIn })}SELECT ${projection} FROM ${fromWith()} WHERE ${allOf([whereOf(params), hostIn(pk as PgColumn)])}`;
  };
  const scopedTupleSql = (
    tuples: readonly (readonly string[])[],
    params: AllParams | null,
  ): SQL =>
    sql`SELECT ${projection} FROM ${fromWith()} WHERE ${allOf([whereOf(params), tupleIn(pkColumns, tuples)])}`;
  // The ids' columns `orderIds` selects: `__id`, or a composite key's parts
  // `__k0`… (composed in JS).
  const idSelect =
    composite === null
      ? sql`${pk as PgColumn} AS __id`
      : sql.join(
          pkColumns.map((c, i) => sql`${c} AS ${sql.identifier(`__k${i}`)}`),
          sql`, `,
        );
  const orderIdsSql = (params: AllParams): SQL => {
    const w = whereOf(params);
    const parts = [
      sql`SELECT ${idSelect} FROM ${fromSql(base, plan, membershipIncluded, label)}`,
    ];
    if (w !== undefined) parts.push(sql`WHERE ${w}`);
    parts.push(sql`ORDER BY ${orderSql}`);
    if (limitSql !== null) parts.push(limitSql);
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
      composite === null
        ? scopedSql(["$ids"], "throws", placeholder)!
        : scopedTupleSql([pkColumns.map((_, i) => `$ids${i}`)], placeholder),
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
  const rowParser = decodedRow(decoders) as unknown as z.ZodType<
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
    if (composite !== null) {
      const parts = pkColumns.map((_, i) => `__k${i}`);
      const rows = await executeRows(db, {
        query: orderIdsSql(params),
        row: decodedRow(Object.fromEntries(parts.map((p) => [p, String]))),
        label: `${key}:orderIds`,
      });
      return capped(rows, "orderIds", params).map((r) =>
        composite.encodeParts(parts.map((p) => r[p] as string)),
      );
    }
    const rows = await executeRows(db, {
      query: orderIdsSql(params),
      row: decodedRow({ __id: String }),
      label: `${key}:orderIds`,
    });
    return capped(rows, "orderIds", params).map((r) => r.__id);
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
      full: rendered.full,
      scoped: rendered.scoped,
      orderIds: rendered.orderIds,
      // A single key keeps its field (the definition every existing set had);
      // a composite one its fields, in order.
      keyField: composite === null ? queryKey : { composite: keyFields },
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
  // The server's gate: the descriptor's (exactly the scope's keys), then
  // what only the compile knows — each value the canonical text of its
  // column's type, the one spelling the feed's `col::text` can equal.
  const validateScope = (params: ResourceParams) => {
    contract.validateParams?.(params);
    for (const s of scope) s.check(key, params[s.field]!);
  };
  const all = {
    loader: (params: AllParams, ctx?: { affectedIds: readonly string[] }) => {
      if (!ctx) {
        return load(fullSql(params), "full").then((rows) =>
          capped(rows, "full", params),
        );
      }
      const scoped = scopedSql(ctx.affectedIds, "throws", params);
      return scoped === null ? Promise.resolve([]) : load(scoped, "scoped");
    },
    ...allPolicy,
    ...(spec.debounceMs != null ? { debounceMs: spec.debounceMs } : {}),
    ...(scope.length === 0 ? {} : { validateParams: validateScope }),
  } as KeyedServerResourceOptions<Row[], AllParams> & ScopePolicy<AllParams>;

  const point = contracts.rows.point;
  const rowsPolicy: ScopePolicy<PointParams> = {
    routes: compiledRoutePlan<PointParams>(routes, usesOf, derivedReads),
    membership: {
      kind: "point",
      idsOf: (params) => point.decode(params),
      // The rows of the ids alone (`scopedSql(ids, …, null)` reads no
      // param), so every tuple is one family (resource-runtime's `PointBatch`).
      batch: {
        familyOf: () => "",
        maxIds: point.maxIds,
        // A composite id is composed in JS from its parts, which the batch
        // does not check one by one: an absent one is re-read alone.
        exactId:
          hostPk === undefined
            ? () => false
            : exactIdOf(canonicalSqlType(hostPk.getSQLType())),
      },
    },
  };
  const rows = {
    // The subscribed ids are the client's: one the pk cannot hold is absent.
    loader: async (
      params: PointParams,
      ctx?: { affectedIds: readonly string[] },
    ) => {
      const ids = ctx?.affectedIds ?? point.decode(params);
      const scoped = ids.length === 0 ? null : scopedSql(ids, "absent", null);
      return scoped === null ? [] : load(scoped, "rows");
    },
    ...rowsPolicy,
  } as KeyedServerResourceOptions<Row[], PointParams> &
    ScopePolicy<PointParams>;

  return {
    all: all as unknown as CompiledAllCollection<Row, AllQueryParams<B>>["all"],
    rows,
    keyField: queryKey,
    definition,
    followable: {
      all:
        scope.length === 0
          ? null
          : followableScope(
              key,
              allPolicy.routes as unknown as RoutePlan<ResourceParams>,
              scope.map((s) => ({ field: s.field, column: s.col.name })),
              validateScope,
            ),
      // An id follow matches the feed's one key column; a composite key
      // has none (a composite-keyed set is followed by its scope).
      rows:
        composite === null
          ? followablePoint(
              contracts.rows.key,
              rowsPolicy.routes as unknown as RoutePlan<ResourceParams>,
              pk as PgColumn,
              (ids) => point.encode(ids),
            )
          : null,
    },
  };
}

/** One field of a scoped set's `by`: its base column, and the canonical-text check of its type. */
interface ScopeField {
  field: string;
  col: PgColumn;
  /** Throws `ResourceContractError` unless `value` is the canonical text of the column's type. */
  check(key: string, value: string): void;
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
    // A decoder that only re-types its text (an id kind's brand) round-trips
    // it: the param, the stored text and the decoded value are one spelling.
    const decoder = columnSchema(col);
    if (decoder !== undefined && !isTextPassthrough(decoder)) {
      fail(
        `the scope field "${field}" (\`all.by\`) is a decoded column (sql-column) — a scope is a plain text, uuid or integer column (or one whose decoder only brands its text): its param is bound as the stored text the change feed carries, which a decoder may not round-trip.`,
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

/** A key as an error names it: its field, or its composite fields. */
function describeKey(key: QueryKey): string {
  return isCompositeKey(key)
    ? `the composite key (${key.fields.join(", ")})`
    : `"${key}"`;
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
