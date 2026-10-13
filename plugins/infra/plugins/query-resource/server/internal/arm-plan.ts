import { and, inArray, is, sql, SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type {
  DerivedRead,
  ResourceParams,
  RoutedRecomputeOn,
  TupleUse,
} from "@plugins/framework/plugins/resource-runtime/core";
import {
  atOrBeforePredicate,
  orderByClauses,
  seekPredicate,
  type SortKey,
} from "@plugins/primitives/plugins/keyset/server";
import {
  BASE_RELATION,
  type JoinFamily,
  type JoinSpec,
} from "@plugins/infra/plugins/query-resource/core";
import { resolveIdentity, wireFieldFor } from "./identity";
import {
  compileJoins,
  familyRoute,
  joinRoutes,
  projectedField,
  routeColumnsOf,
  sameColumn,
  type JoinPlan,
  type ReadColumn,
  type RelationColumn,
} from "./joins";
import { baseIdentityRoute, type RawRoute, type RoutedBase } from "./routes";
import { anyOf } from "./raw-sql";
import type {
  QueryDb,
  QueryStep,
  RoutedSource,
  SelectMap,
  WindowOrderKey,
  WindowQueryResourceSpec,
} from "./spec";

// One ARM of a bounded compile: a base table, its joins, its projection and its
// per-tuple SQL — everything about one relation set that the window / point
// assembler (`./compile-window`) turns into loaders, membership and a scope
// policy. The single-table compiler is the 1-arm case. What other compilers
// share is the ROUTED half (`routedReads`): a union window (P6) routes each arm
// through it and renders its own positional SQL, and so does the persisted
// `all` collection (P8, `./compile-alias`) — its shapes are raw SQL, never an
// `ArmMode` (C2 of research/2026-10-06-global-scoped-change-routing-p8-v3.md).
//
// An arm RENDERS and never executes: each `…Query` returns the drizzle step the
// assembler awaits, so the assembler owns what a load costs and when it runs.

/** What the arm's SQL is for: a bounded ordered window, or a point (id-set) read. */
export type ArmMode = { kind: "window" } | { kind: "point" };

/** One tuple's SQL: its `where`, the joins it includes, and its read-set. */
export interface TupleReads {
  where: SQL | undefined;
  /** The joins this tuple's SQL includes — every shape of it (full, scoped, ids, point). */
  included: ReadonlySet<string>;
  /** `usesOf`'s answer: the base, and every included join in its role (with its `moves`). */
  uses: ReadonlyMap<string, TupleUse>;
}

/**
 * One tuple's order: its keys, their ORDER BY, and the extra projection it
 * rides — its row-key parts, and the family members it orders by
 * (`members`: each one's projection alias and join alias).
 */
export interface OrderPlan {
  keys: SortKey[];
  sql: SQL[];
  keySelect: SelectMap;
  members: readonly (readonly [part: string, alias: string])[];
}

/**
 * One part of a tuple's order signature: the signature column at `index`
 * (the field the assembler's signature list projects it under), or a family
 * member the tuple orders by, read off the row's `valuesKey` object.
 */
export type SignaturePart =
  | { kind: "column"; index: number }
  | { kind: "member"; valuesKey: string; alias: string };

/** A window arm's order: its resolver, its cuts, and the signature it is signed by. */
export interface ArmOrder<P> {
  /** A family member's join alias, when an order key reads one. */
  memberAliasOf(col: ReadColumn): string | undefined;
  /** The tuple's order plan (memoized per canonical order). */
  orderPlanOf(params: P): OrderPlan;
  /** The tuple's page cuts on the order side, if any. */
  cutWhere(params: P): SQL | undefined;
  /**
   * The projected field of each signature column, in `signatureColumns`
   * order — where the assembler reads a `column` signature part's field.
   */
  signatureFields: readonly string[];
  /** The parts of the tuple's order signature (the pk tiebreaker excluded: immutable). */
  signatureOf(params: P): readonly SignaturePart[];
}

/**
 * The contract every arm hands the assembler. `mode` says which renders it
 * offers: a window arm adds its order and the full / scoped / ids renders; a
 * point arm renders only by id.
 */
export interface ArmPlanBase<Row, P extends ResourceParams> {
  mode: ArmMode;
  label: string;
  base: RoutedBase;
  joins: JoinPlan;
  pkColumn: PgColumn;
  /** The wire field the pk is projected under — the row's key. */
  keyField: string;
  /**
   * What the arm projects, in projection order (a union aliases its arms
   * positionally): each wire field and the expression it reads — a column, a
   * defaulted one, or a rendered `ExprField` (`JoinPlan.renderExpr`).
   */
  projection: readonly { outer: string; read: SelectMap[string] }[];
  /** The routes its SQL reads: the base's `identity`, one per join and per family. */
  routes: readonly RawRoute[];
  /** One tuple's reads — the base, its joins, their roles and `moves`. */
  tuple(params: P): TupleReads;
  recomputeOn?: ReadonlyArray<RoutedRecomputeOn>;
  /** The tuple's rows among `ids` (its `where` ∧ pk IN ids; no order, no limit, no cuts), projecting every part `fold` reads. */
  pointQuery(params: P, ids: readonly string[]): QueryStep<Row>;
  /** Folds what the SQL projected beyond the row (row-key parts, ordered members) into it. */
  fold(rows: Row[], params: P): Row[];
}

export interface WindowArmPlan<
  Row,
  P extends ResourceParams,
> extends ArmPlanBase<Row, P> {
  mode: { kind: "window" };
  order: ArmOrder<P>;
  /** The windowed query: `where ∧ cuts → ORDER BY → LIMIT limit`. */
  fullQuery(params: P, limit: number): QueryStep<Row>;
  /** The scoped refill: `where ∧ cuts ∧ pk IN ids`, no order or limit. */
  scopedQuery(params: P, ids: readonly string[]): QueryStep<Row>;
  /** The membership authority: the full query's where / cuts / order / limit, projecting the pk alone. */
  idsQuery(params: P, limit: number): QueryStep<Record<string, unknown>>;
}

export interface PointArmPlan<
  Row,
  P extends ResourceParams,
> extends ArmPlanBase<Row, P> {
  mode: { kind: "point" };
}

export type ArmPlan<Row, P extends ResourceParams> =
  WindowArmPlan<Row, P> | PointArmPlan<Row, P>;

/** What one arm is planned from: its relation set, and its mode's declaration. */
export interface ArmInput<P extends ResourceParams> {
  /** The resource key, for misuse messages. */
  key: string;
  label: string;
  /** The routed base `from` names (A1-checked by the caller). */
  base: RoutedBase;
  from: RoutedSource;
  identity?: { pk: PgColumn };
  select?: SelectMap;
  joins?: readonly JoinSpec[];
  where: WindowQueryResourceSpec<P>["where"];
  whereReads?: readonly (PgColumn | SQL)[];
  recomputeOn?: ReadonlyArray<RoutedRecomputeOn>;
  db: QueryDb;
  mode:
    | { kind: "point" }
    | {
        kind: "window";
        /** The declared order: static keys, or a per-params resolver. */
        order:
          | { kind: "static"; keys: readonly WindowOrderKey[] }
          | {
              kind: "function";
              resolve: (params: P) => WindowOrderKey[];
            };
        /** The columns any tuple may order by — the universe the signature is cut from. */
        signatureColumns: readonly ReadColumn[];
        families?: { joins: readonly JoinFamily[]; valuesKey: string };
        /** Its tuples' page cuts, and where each row's key is folded. */
        rowKey: WindowQueryResourceSpec<P>["rowKey"];
      };
}

function guard(
  condition: unknown,
  key: string,
  message: string,
): asserts condition {
  if (!condition) {
    throw new Error(`windowQueryResource("${key}"): ${message}`);
  }
}

/** The projection alias of a row key's i-th part (never a row field: it is folded away). */
const rowKeyPart = (i: number): string => `__row_key_${i}`;

/** The projection alias of the i-th family member a tuple orders by (folded under `valuesKey`). */
const familyPart = (i: number): string => `__family_${i}`;

const VALUE: TupleUse = { role: "value" };

/**
 * A rollup read as membership: every column of a source route may move the
 * tuple. Its `moves` cannot be cut from the reader's SQL — that reads ROLLUP
 * columns, while the routes sit on the rollup's sources — so it is absent
 * ("every column"); each source route's own `columns` gate still skips a
 * write the rollup does not read.
 */
const MEMBERSHIP_ANY: TupleUse = { role: "membership" };

/**
 * The routed half of a relation set (`routedReads`): its routes, each tuple's
 * reads, and the derived tables (rollups) its SQL reads beside the route
 * tables — what a plan mints as `RoutePlanInput.derivedReads` (empty unless a
 * rollup is joined, which only the `all` compiler does).
 */
export interface RoutedReads<P extends ResourceParams> {
  routes: RawRoute[];
  tuple: (params: P) => TupleReads;
  derivedReads: readonly DerivedRead[];
}

/**
 * The routed half of an arm (exported for the union compiler, which renders
 * its own positional SQL but routes each arm exactly as a single-table arm is
 * routed — `./compile-union-window`): the routes (the base's `identity`, then
 * each declared join's — `joinRoutes`: one for a window join, one per source
 * for a rollup) and each tuple's reads, derived from the SQL fragments the
 * renders produce — never declared beside them. A tuple includes a join when
 * its SQL references it (projected, a required lookup, or named by its `where`
 * / order) or a join hangs off it; the join is read as `membership` when it can
 * move the tuple's membership or order (required, or referenced — through a
 * later join in its chain too — by the `where` / order), else as `value` (a
 * LEFT join that is only projected). A tuple reading a join names every route
 * the join is reached by (`JoinPlan.routeIdsOf`), in that role.
 */
export function routedReads<P extends ResourceParams>(opts: {
  label: string;
  base: RoutedBase;
  joins: JoinPlan;
  /**
   * What the SQL projects: the `select` map, or — with none — every column of
   * the source (`resolveIdentity`'s `columns`), which a select-all reads.
   */
  projection: SelectMap;
  pk: PgColumn;
  /** The wire field the pk is projected under. */
  keyField: string;
  where: WindowQueryResourceSpec<P>["where"];
  whereReads: readonly (PgColumn | SQL)[] | undefined;
  /** Every column any tuple may order by (the signature); `[]` for a point set. */
  orderColumns: readonly ReadColumn[];
  orderOf: (params: P) => readonly WindowOrderKey[];
  /** What a lookup's reverse route probes the hosts with. */
  db: QueryDb;
}): RoutedReads<P> {
  const { joins, where, projection } = opts;
  if (
    joins
      .columnsIn(projection[opts.keyField])
      .some(([relation]) => relation !== BASE_RELATION)
  ) {
    throw new Error(
      `${opts.label}: the key field "${opts.keyField}" projects a joined column — a row's key is its base table's identity.`,
    );
  }
  const projected = joins.relationsIn(Object.values(projection));
  const open = typeof where === "function" && opts.whereReads === undefined;
  const reads: RelationColumn[] = [
    ...joins.columnsIn(Object.values(projection)),
    ...joins.columnsIn(opts.pk),
    ...joins.columnsIn(typeof where === "function" ? undefined : where),
    ...joins.columnsIn(opts.whereReads ?? []),
    ...joins.columnsIn(opts.orderColumns),
  ];
  const columnsOf = routeColumnsOf(joins, opts.base, reads, open);
  const host = { base: opts.base, pk: opts.pk, plan: joins, db: opts.db };
  const routes = [
    baseIdentityRoute(opts.base, opts.pk, columnsOf(BASE_RELATION)),
    ...joins.joins.flatMap((j) => joinRoutes(j, host, columnsOf)),
    // One route per family, whatever its members: which members a tuple
    // reads is its `match`, not a route of its own.
    ...joins.families.map((f) => familyRoute(f)),
  ];

  const tuple = (params: P): TupleReads => {
    const w = typeof where === "function" ? where(params) : where;
    const whereCols = joins.columnsIn(w);
    if (typeof where === "function" && !open) {
      for (const [relation, column] of whereCols) {
        // A family member's columns are its route's, whatever the member.
        if (joins.familyOf(relation) !== undefined) continue;
        if (!columnsOf(relation).includes(column)) {
          throw new Error(
            `${opts.label}: the \`where\` reads "${relation}"."${column}", which is not in \`whereReads\` — the route columns would miss it. Declare it there.`,
          );
        }
      }
    }
    const order = opts.orderOf(params);
    const seeds = new Set<string>(joins.required);
    for (const [relation] of whereCols) seeds.add(relation);
    // An order key's relations — one for a column, every one an expression
    // reads (an `ExprField` over a lookup reads the lookup as membership).
    for (const k of order) {
      for (const relation of joins.relationsIn(k.col)) seeds.add(relation);
    }
    const membership = joins.closure(seeds);
    const included = joins.closure([...membership, ...projected]);
    // Per relation, the columns whose change can move THIS tuple: what its
    // `where` and order read, and the conditions of the joins it reads as
    // membership (a moved key re-points an INNER join, or the row a filtered /
    // sorted join reads). A U touching none of them cannot move the tuple
    // (`TupleUse.moves`): the runtime delivers it as a value change.
    const moving = new Map<string, Set<string>>();
    const conditions = joins.joins
      .filter((j) => membership.has(j.alias))
      .flatMap((j) => joins.columnsIn(j.on));
    for (const [relation, column] of [
      ...whereCols,
      ...joins.columnsIn(order.map((k) => k.col)),
      ...conditions,
    ]) {
      let set = moving.get(relation);
      if (!set) moving.set(relation, (set = new Set()));
      set.add(column);
    }
    const membershipUse = (relation: string): TupleUse => ({
      role: "membership",
      moves: [...(moving.get(relation) ?? [])].sort(),
    });
    const uses = new Map<string, TupleUse>([
      [BASE_RELATION, membershipUse(BASE_RELATION)],
    ]);
    for (const j of joins.joins) {
      if (!included.has(j.alias)) continue;
      const use = !membership.has(j.alias)
        ? VALUE
        : j.spec.kind === "rollup"
          ? MEMBERSHIP_ANY
          : membershipUse(j.alias);
      // One id for a window join (its alias); one per source for a rollup.
      for (const id of joins.routeIdsOf(j.alias)) uses.set(id, use);
    }
    // A family's members are joined only where a `where` / order names them,
    // so a tuple reads its family as membership, matching those members.
    const members = new Map<string, Set<string>>();
    for (const relation of included) {
      const m = joins.familyOf(relation);
      if (m === undefined) continue;
      let set = members.get(m.family.id);
      if (!set) members.set(m.family.id, (set = new Set()));
      set.add(m.member);
    }
    for (const family of joins.families) {
      const set = members.get(family.id);
      if (set === undefined) continue;
      uses.set(family.id, {
        role: "membership",
        match: { [family.member.name]: set },
      });
    }
    return { where: w, included, uses };
  };

  return { routes, tuple, derivedReads: joins.derivedReads };
}

/**
 * Plan one arm. Every misuse its relation set can carry (a join without an
 * explicit `select`, an unprojected or uncovered order column, a key field
 * read through a join) throws HERE, at module eval.
 */
export function planArm<Row, P extends ResourceParams>(
  input: ArmInput<P> & { mode: { kind: "window" } },
): WindowArmPlan<Row, P>;
export function planArm<Row, P extends ResourceParams>(
  input: ArmInput<P> & { mode: { kind: "point" } },
): PointArmPlan<Row, P>;
export function planArm<Row, P extends ResourceParams>(
  input: ArmInput<P>,
): ArmPlan<Row, P> {
  const { key, label, base, db, where } = input;
  const mode = input.mode;
  const { rel, pkColumn, keyField, selectMap, columns } = resolveIdentity(
    input.from,
    input.identity,
    input.select,
  );
  const families = mode.kind === "window" ? mode.families : undefined;
  const joins = compileJoins(
    base,
    input.joins ?? [],
    pkColumn,
    label,
    ...(mode.kind === "window" ? [families?.joins ?? []] : []),
  );
  guard(
    joins.joins.length === 0 || input.select !== undefined,
    key,
    "a spec with `joins` needs an explicit `select` — the projection names each joined column it puts on the wire.",
  );
  const projectionMap: SelectMap = selectMap ?? columns;
  const projection = Object.entries(projectionMap).map(([outer, read]) => ({
    outer,
    read,
  }));

  // The arm's rows: `select` (or every column) from the base, the tuple's
  // joins applied — plus, for a window, the extra projection its order rides.
  const selectFrom = (
    included: ReadonlySet<string>,
    extra?: SelectMap,
  ): QueryStep<Row> => {
    const fields =
      extra === undefined || Object.keys(extra).length === 0
        ? selectMap
        : { ...projectionMap, ...extra };
    return joins.apply(
      (fields ? db.select<Row>(fields) : db.select<Row>()).from(rel),
      included,
    );
  };
  const recomputeOn =
    input.recomputeOn !== undefined ? { recomputeOn: input.recomputeOn } : {};

  if (mode.kind === "point") {
    const reads = routedReads<P>({
      label,
      base,
      joins,
      projection: projectionMap,
      pk: pkColumn,
      keyField,
      where,
      whereReads: input.whereReads,
      orderColumns: [],
      orderOf: () => [],
      db,
    });
    return {
      mode: { kind: "point" },
      label,
      base,
      joins,
      pkColumn,
      keyField,
      projection,
      routes: reads.routes,
      tuple: reads.tuple,
      ...recomputeOn,
      // A point set's ids are the client's (`:rows` params — a URL, a stale
      // link), which nothing checked against the pk's type: one the pk cannot
      // hold (`"x"` against a uuid) is absent, like an unknown id, never an
      // invalid-input error that fails the whole load. The runtime's own
      // refill ids (vouched for) pass the same check unchanged.
      pointQuery: (params, ids) => {
        const { where: w, included } = reads.tuple(params);
        const pred = anyOf(pkColumn, ids, { invalid: "absent" });
        return selectFrom(included).where(w ? and(w, pred)! : pred);
      },
      fold: (rows) => rows,
    };
  }

  const declaredOrder = mode.order;
  const staticOrder =
    declaredOrder.kind === "static" ? declaredOrder.keys : undefined;
  const orderFn =
    declaredOrder.kind === "function" ? declaredOrder.resolve : undefined;
  const signatureColumns = mode.signatureColumns;
  const nameOf = (col: ReadColumn): string => joins.nameOf(col);
  // A family member's alias, when the order key reads one.
  const memberAliasOf = (col: ReadColumn): string | undefined =>
    joins.memberOf(col);
  // A family member the tuple orders by is signed through its own projection
  // (`familyPart`), not `signatureColumns`, whose universe is static.
  const covered = (col: ReadColumn): boolean =>
    sameColumn(col, pkColumn) ||
    signatureColumns.some((c) => sameColumn(c, col)) ||
    memberAliasOf(col) !== undefined;
  // An order column outside the signature would reorder without the runtime
  // noticing — the tuple's order would go stale. Checked at module eval for a
  // static order, per resolved order for a function one.
  const assertCovered = (order: readonly WindowOrderKey[]): void => {
    for (const k of order) {
      guard(
        covered(k.col),
        key,
        `the order column "${nameOf(k.col)}" is not in \`signatureColumns\` — an UPDATE to it would leave the window's order stale. Add it to \`signatureColumns\`.`,
      );
    }
  };
  if (staticOrder) assertCovered(staticOrder);
  // A joined sortable column is projected and signed like a base one (A4): a
  // side-table write that moves it then moves the signature, so the runtime
  // re-derives the window rather than leave the order stale.
  const signatureFields = signatureColumns.map((col) => {
    // A select-all projects only the source's columns; an expression or an
    // aggregate (which reads no one column) is projected only by an explicit
    // `select`.
    const field = selectMap
      ? projectedField(selectMap, col)
      : joins.isComputed(col)
        ? undefined
        : wireFieldFor(undefined, columns, joins.columnOf(col));
    guard(
      field !== undefined,
      key,
      `the order column "${nameOf(col)}" is not projected — the window's order ` +
        `signature is derived from the wire row, so every declared order column ` +
        `must appear in \`select\`.`,
    );
    return field;
  });
  // The parts THIS tuple is signed by: the columns it orders by (the pk
  // tiebreaker excluded — immutable), so a write to a column only another
  // tuple sorts by — a joined `lastPlayedAt` under a `title` sort — leaves
  // this tuple's signature still and costs it no ids query.
  const signatureOf = (params: P): readonly SignaturePart[] => {
    const order = staticOrder ?? orderFn!(params);
    assertCovered(order);
    return order.flatMap((k): SignaturePart[] => {
      const alias = memberAliasOf(k.col);
      if (alias !== undefined) {
        return [{ kind: "member", valuesKey: families!.valuesKey, alias }];
      }
      const index = signatureColumns.findIndex((c) => sameColumn(c, k.col));
      // Not a signature column ⇒ the pk (`assertCovered`): immutable.
      return index === -1 ? [] : [{ kind: "column", index }];
    });
  };

  // Declared order keys + the pk tiebreaker (skipped when a key already targets
  // the pk column — same rule as keyset's `buildSortKeys`), rendered with
  // explicit NULLS LAST so a cut's seek stays symmetric. ONE key list per
  // order feeds the ORDER BY, a page's cuts and its row keys, so the three
  // cannot disagree about what the order is.
  //
  // A column a LEFT join reads is NULL for a host with no joined row, whatever
  // its own NOT NULL says — so it orders as nullable.
  const orderKeys = (declared: readonly WindowOrderKey[]): SortKey[] => {
    const keys: SortKey[] = declared.map((k) => ({
      fieldId: nameOf(k.col),
      col: k.col,
      dir: k.dir ?? "asc",
      nullable: (k.nullable ?? false) || joins.canBeNull(k.col),
    }));
    if (!keys.some((k) => sameColumn(k.col as ReadColumn, pkColumn))) {
      keys.push({
        fieldId: pkColumn.name,
        col: pkColumn,
        dir: "asc",
        nullable: false,
      });
    }
    return keys;
  };
  const rowKey = mode.rowKey;
  const planOrder = (declared: readonly WindowOrderKey[]): OrderPlan => {
    const keys = orderKeys(declared);
    const members = declared.flatMap((k, i) => {
      const alias = memberAliasOf(k.col);
      return alias === undefined
        ? []
        : [{ part: familyPart(i), alias, col: k.col }];
    });
    return {
      keys,
      sql: orderByClauses(keys),
      keySelect: {
        // The row key's parts, as Postgres's own text: exact, whatever the type.
        ...Object.fromEntries(
          keys.map((k, i) => [
            rowKeyPart(i),
            sql`${k.col}::text`.as(rowKeyPart(i)),
          ]),
        ),
        ...Object.fromEntries(
          members.map(({ part, col }) => [part, sql`${col}`.as(part)]),
        ),
      },
      members: members.map(({ part, alias }) => [part, alias] as const),
    };
  };
  const staticPlan = staticOrder ? planOrder(staticOrder) : undefined;
  // Per-params order, memoized per canonical order. Bounded by the resolver's
  // own vocabulary (its sortable columns × directions × the SQL types a
  // column may read as), never by the params.
  //
  // A key's rendering is part of its identity: a family member keeps its
  // alias and column when its definition is retyped, but reads through a
  // different cast (`readMember` hands one registered expression per cast) —
  // keyed on the name alone, the ORDER BY, the `$scoped` projection and a
  // cut's operand cast would keep the old cast after the retype. So an
  // expression key also names its SQL type and the expression object (every
  // expression a plan reads is registered and cached by it: bounded); a plain
  // column is its relation and name.
  const orderMemo = new Map<string, OrderPlan>();
  const expressionIds = new WeakMap<SQL, number>();
  let nextExpressionId = 0;
  const renderingOf = (col: ReadColumn): string | number => {
    if (!is(col, SQL)) return "column";
    let id = expressionIds.get(col);
    if (id === undefined) {
      id = nextExpressionId++;
      expressionIds.set(col, id);
    }
    return id;
  };
  const orderPlanOf = (params: P): OrderPlan => {
    if (staticPlan) return staticPlan;
    const declared = orderFn!(params);
    const canonical = JSON.stringify(
      declared.map((k) => [
        joins.relationKey(k.col),
        nameOf(k.col),
        joins.sqlTypeOf(k.col),
        renderingOf(k.col),
        k.dir ?? "asc",
        k.nullable ?? false,
      ]),
    );
    let plan = orderMemo.get(canonical);
    if (!plan) {
      assertCovered(declared);
      plan = planOrder(declared);
      orderMemo.set(canonical, plan);
    }
    return plan;
  };
  const orderSqlOf = (params: P): SQL[] => orderPlanOf(params).sql;

  // A page's cuts, compiled on the ORDER side over the tuple's own
  // keys: `after` exclusive (the keyset seek), `until` inclusive. Each operand
  // is a key's exact text, cast back to its column's type — so Postgres
  // compares the value it stored, not a rounded one.
  const cutWhere = (params: P): SQL | undefined => {
    const { after, until } = rowKey.cutsOf(params);
    if (after === undefined && until === undefined) return undefined;
    const { keys } = orderPlanOf(params);
    const operands = (
      cut: readonly (string | null)[],
      which: string,
    ): unknown[] => {
      guard(
        cut.length === keys.length,
        key,
        `the "${which}" cut has ${cut.length} value(s) for the tuple's ${keys.length} order key(s) — a cut is a row key of exactly this order.`,
      );
      return cut.map((v, i) =>
        v === null
          ? null
          : sql`${v}::${sql.raw(joins.sqlTypeOf(keys[i]!.col as ReadColumn))}`,
      );
    };
    const parts: SQL[] = [];
    if (after !== undefined) {
      parts.push(seekPredicate(keys, operands(after, "after"))!);
    }
    if (until !== undefined) {
      parts.push(atOrBeforePredicate(keys, operands(until, "until")));
    }
    return parts.length === 1 ? parts[0] : and(...parts);
  };

  // Folds a row's key parts into its row key (the canonical JSON of the
  // parts; `null` over the byte bound), and the family members the tuple
  // orders by into `valuesKey` (by join alias); drops the parts: they are not
  // row fields. Every full and scoped row goes through it, before `encodeRow`.
  // A part the render did not project is a render that skipped `keySelect`:
  // folding it would mint a bogus key or a null member, so it throws.
  const assertProjected = (row: Record<string, unknown>, part: string) => {
    if (!(part in row)) {
      throw new Error(
        `${label}: fold read a row without its projected order part "${part}" — the query that produced it did not select the order plan's keySelect`,
      );
    }
  };
  const fold = (rows: Row[], params: P): Row[] => {
    const plan = orderPlanOf(params);
    const n = plan.keys.length;
    return rows.map((r) => {
      const row = { ...(r as Record<string, unknown>) };
      const parts: (string | null)[] = [];
      for (let i = 0; i < n; i++) {
        assertProjected(row, rowKeyPart(i));
        parts.push(row[rowKeyPart(i)] as string | null);
        delete row[rowKeyPart(i)];
      }
      const json = JSON.stringify(parts);
      row[rowKey.keyField] =
        Buffer.byteLength(json, "utf8") > rowKey.maxKeyBytes ? null : json;
      if (plan.members.length > 0) {
        const values: Record<string, unknown> = {};
        for (const [part, alias] of plan.members) {
          assertProjected(row, part);
          values[alias] = row[part] ?? null;
          delete row[part];
        }
        row[families!.valuesKey] = values;
      }
      return row as Row;
    });
  };

  const reads = routedReads<P>({
    label,
    base,
    joins,
    projection: projectionMap,
    pk: pkColumn,
    keyField,
    where,
    whereReads: input.whereReads,
    orderColumns: signatureColumns,
    orderOf: (params) => (staticOrder ? staticOrder : orderFn!(params)),
    db,
  });

  // The tuple's `where` (checked against its declared universe by
  // `reads.tuple`), ANDed with its page cuts — order-side, checked against
  // its order keys instead.
  const whereOf = (params: P, w: SQL | undefined): SQL | undefined => {
    const cut = cutWhere(params);
    return w && cut ? and(w, cut) : (w ?? cut);
  };

  return {
    mode: { kind: "window" },
    label,
    base,
    joins,
    pkColumn,
    keyField,
    projection,
    routes: reads.routes,
    tuple: reads.tuple,
    ...recomputeOn,
    order: {
      memberAliasOf,
      orderPlanOf,
      cutWhere,
      signatureFields,
      signatureOf,
    },
    // A row's key parts and the family members its order reads ride
    // the projection (see `planOrder`); a select-all spec projects the
    // source's columns explicitly so they can join them.
    fullQuery: (params, limit) => {
      const { where: tw, included } = reads.tuple(params);
      const w = whereOf(params, tw);
      let q = selectFrom(included, orderPlanOf(params).keySelect);
      if (w) q = q.where(w);
      return q.orderBy(...orderSqlOf(params)).limit(limit);
    },
    scopedQuery: (params, ids) => {
      const { where: tw, included } = reads.tuple(params);
      const w = whereOf(params, tw);
      const pred = inArray(pkColumn, [...ids]);
      return selectFrom(included, orderPlanOf(params).keySelect).where(
        w ? and(w, pred)! : pred,
      );
    },
    idsQuery: (params, limit) => {
      // The SAME joins as the loader (the tuple's reads), so the membership
      // authority and the rows it admits read one relation set.
      const { where: tw, included } = reads.tuple(params);
      const w = whereOf(params, tw);
      let q: QueryStep<Record<string, unknown>> = joins.apply(
        db.select<Record<string, unknown>>({ [keyField]: pkColumn }).from(rel),
        included,
      );
      if (w) q = q.where(w);
      return q.orderBy(...orderSqlOf(params)).limit(limit);
    },
    // By id, no cuts — but with the same order parts as the full and scoped
    // renders, so `fold` sees every part it folds.
    pointQuery: (params, ids) => {
      const { where: w, included } = reads.tuple(params);
      const pred = inArray(pkColumn, [...ids]);
      return selectFrom(included, orderPlanOf(params).keySelect).where(
        w ? and(w, pred)! : pred,
      );
    },
    fold,
  };
}
