import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db as realDb } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import {
  decodedRow,
  nullable,
  type SqlDecoderLike,
} from "@plugins/database/plugins/sql-projection/server";
import type {
  FullRoute,
  KeyedMembership,
  KeyedServerResourceOptions,
  ResourceParams,
  ScopePolicy,
  TupleUse,
} from "@plugins/framework/plugins/resource-runtime/core";
import {
  atOrBeforePredicate,
  orderByClauses,
  seekPredicate,
  type SortKey,
} from "@plugins/primitives/plugins/keyset/server";
import {
  armKeyCodec,
  type ArmKeyCodec,
  type JoinSpec,
} from "@plugins/infra/plugins/query-resource/core";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import { SQL_TYPE_RE } from "../../core/internal/expr";
import { routedReads, type TupleReads } from "./arm-plan";
import { armKeySql } from "./arm-key-sql";
import {
  planGroupArm,
  type CompiledGroups,
  type GroupArmPlan,
} from "./compile-groups";
import { compileJoins, type JoinPlan, type ReadColumn } from "./joins";
import {
  allOf,
  anyOf,
  canonicalSqlType,
  decoderOfRead,
  fromSql,
  nullOf,
} from "./raw-sql";
import {
  compiledReachPlan,
  compiledUnionRoutePlan,
  routedBase,
  tablePrimary,
  unionRouteId,
  type RoutedBase,
} from "./routes";
import type { QueryDb, RoutedSource, WindowOrderKey } from "./spec";

// The UNION window compiler (P6 of
// research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md, step 12a): one
// collection over N tables — an ARM per table, each listing its rows under one
// key space (`<kind>:<raw id>`, `armKeyCodec`) and one total order — compiled
// into the three resources a `liveCollection({ arms })` mints:
//
// - the WINDOW: per surviving arm `SELECT … WHERE arm.where ∧ whereOf ∧ cut
//   ORDER BY … LIMIT n`, `UNION ALL`ed, re-ordered and re-limited outside; its
//   scoped refill (ids decoded per arm, `pk = ANY`, no order) and its
//   `windowIdsOf` (the full shape, projecting the key and the order columns);
// - the `:rows` POINT read: ids grouped by kind over every arm, `arm.where`
//   kept, an unknown kind or undecodable key simply absent;
// - the `:groups` value: a per-arm `GROUP BY`, summed outside.
//
// Each arm is ROUTED exactly as a single-table compile is (`routedReads`, the
// arm planner's routed half): its base `identity`, one route per declared join,
// each gated by the columns its SQL reads — so a `pid` write routes nowhere —
// and the routes are re-keyed into the union's key space by
// `compiledUnionRoutePlan`. The SQL is rendered here, positionally (`__kind`,
// `__key`, `__c<i>`), and run raw (`QueryDb.execute` + `decodedRow`): the outer
// order keys are expressions over the union, which drizzle's `unionAll` cannot
// render.
//
// Three rules make the merge well defined:
//
// - **Static nullability.** A column is nullable when ANY registered arm reads
//   NULL for it (it projects none, or its read can be NULL) — computed once at
//   bind, over every arm, never per surviving arm: a signature or a cut can then
//   never depend on which arms a tuple pruned.
// - **Aligned projections.** An arm with no such column projects
//   `NULL::<sqlType>`; every arm's read of a column is checked (at bind) to
//   produce the column's one SQL type.
// - **Total order.** The tuple's order keys, then the row key (`kind:raw`): two
//   ledgers may mint the same raw id, never the same key.
//
// Layering: this module knows tables, joins, SQL and routes. The filter
// language (which arms a tuple keeps, an arm's compiled `where`) and the row's
// wire shape are the caller's (network/live's `serveUnionCollection`).

/** One arm: a table, its id, its joins, and the columns it projects. */
export interface UnionArmSpec {
  /** The arm's kind — its rows' discriminator value and their keys' prefix. */
  kind: string;
  /** Its base table — never a view (A1). */
  from: RoutedSource;
  /** Its id: the base table's single-column primary key (A14). */
  id: PgColumn;
  joins?: readonly JoinSpec[];
  /**
   * Outer column → this arm's rendered read (a column of the base or a join,
   * or a rendered `ExprField`). A column absent here is `NULL` in this arm.
   */
  reads: Readonly<Record<string, ReadColumn>>;
  /** The arm's always-on scope (ANDed into every shape). */
  where?: SQL;
  /** Every column a per-tuple predicate of this arm (`whereOf`, a grouping's `where`) may read. */
  whereReads: readonly (PgColumn | SQL)[];
}

/** One outer column: its name on the row, and the SQL type every arm produces it as. */
export interface UnionColumn {
  name: string;
  sqlType: string;
}

/** One key of a tuple's order, by outer name (a column, the discriminator, or the key field). */
export interface UnionOrderKey {
  name: string;
  dir: "asc" | "desc";
}

/** A tuple's page cuts: each a row key of exactly its order (the tiebreaker included). */
export interface UnionCuts {
  after?: readonly (string | null)[];
  until?: readonly (string | null)[];
}

/** One grouping tuple, decoded by the caller. */
export interface UnionGroupsQuery {
  /** The grouped column (an outer column or the discriminator). */
  groupBy: string;
  /** The arms the grouping's `where` can match (the rest pruned). */
  arms: ReadonlySet<string>;
  /** The grouping's `where` in one arm. */
  whereOf: (kind: string) => SQL | undefined;
  limit: number;
  /** Throws on a group value the row type cannot hold. */
  check: (value: unknown) => void;
}

export interface UnionCollectionSpec<
  WP extends ResourceParams,
  PP extends ResourceParams,
  GP extends ResourceParams,
> {
  /** The collection key — for messages and SQL labels. */
  key: string;
  /** The row field the compiler projects each row's key (`kind:raw`) under. */
  keyField: string;
  /** The row field the compiler projects each row's kind under. */
  discriminator: string;
  /** Every other row field, in projection order, with its SQL type. */
  columns: readonly UnionColumn[];
  arms: readonly UnionArmSpec[];
  /** Every outer name any tuple may order by — the routes' order-column universe. */
  sortable: readonly string[];
  window: {
    /** The arms the tuple's filter can match (the rest pruned: no SQL, no routes). */
    armsOf: (params: WP) => ReadonlySet<string>;
    /** The tuple's filter, compiled against one arm's columns. */
    whereOf: (params: WP, kind: string) => SQL | undefined;
    orderOf: (params: WP) => readonly UnionOrderKey[];
    /** The tuple's limit (already clamped). */
    limitOf: (params: WP) => number;
    cutsOf: (params: WP) => UnionCuts;
    /** The tuple's page family: one string per query, whatever its cuts and limit (see `WindowQueryResourceSpec.rowKey.familyOf`). */
    familyOf: (params: WP) => string;
    validateParams?: (params: ResourceParams) => void;
  };
  /** Where a window row carries its row key, and the key's byte bound. */
  rowKey: { keyField: string; maxKeyBytes: number };
  point: { idsOf: (params: PP) => string[] };
  groups: { query: (params: GP) => UnionGroupsQuery };
  /** How the order signature reads a name off a (wire-encoded) row. */
  readField: (row: Record<string, unknown>, name: string) => unknown;
  /** The row's wire encoding (fold, codecs), applied to every row a loader returns. */
  encodeRow?: (row: Record<string, unknown>) => Record<string, unknown>;
  /** Test seam. Defaults to the real per-worktree drizzle `db`. */
  db?: QueryDb;
}

export interface CompiledUnion<
  Row,
  WP extends ResourceParams,
  PP extends ResourceParams,
  GP extends ResourceParams,
> {
  window: KeyedServerResourceOptions<Row[], WP> & ScopePolicy<WP>;
  rows: KeyedServerResourceOptions<Row[], PP> & ScopePolicy<PP>;
  groups: CompiledGroups<{ value: unknown; count: number }, GP>;
}

// ── Arms ────────────────────────────────────────────────────────────────────

interface OuterColumn {
  name: string;
  /** Its positional alias in every arm's projection. */
  alias: string;
  sqlType: string;
  /** Static, over every registered arm. */
  nullable: boolean;
}

interface Arm {
  kind: string;
  codec: ArmKeyCodec;
  base: RoutedBase;
  plan: JoinPlan;
  pk: PgColumn;
  where: SQL | undefined;
  /** This arm's value of an outer column: its read, or a constant. */
  valueOf(col: OuterColumn): ReadColumn;
  /** Whether this arm's value of a column is a constant (no read). */
  constant(col: OuterColumn): boolean;
  /** Decodes this arm's rows (by positional alias). */
  decoderOf(col: OuterColumn): SqlDecoderLike;
  window: {
    routes: ReturnType<typeof routedReads>["routes"];
    tuple: (params: ResourceParams) => TupleReads;
  };
  point: {
    routes: ReturnType<typeof routedReads>["routes"];
    tuple: (params: ResourceParams) => TupleReads;
  };
  groups: GroupArmPlan<{ value: unknown; count: number }, ResourceParams>;
}

/** Memoize a per-params answer (the runtime hands one params object per tuple). */
function perParams<P extends object, T>(
  fn: (params: P) => T,
): (params: P) => T {
  const memo = new WeakMap<P, T>();
  return (params) => {
    let v = memo.get(params);
    if (v === undefined && !memo.has(params)) {
      v = fn(params);
      memo.set(params, v);
    }
    return v as T;
  };
}

/**
 * Compile a union collection's three server halves (see the header). Every
 * misuse its declaration can carry throws HERE — at `bindDeferredResources`,
 * since a union's arms are registered in the register phase.
 */
export function compileUnionCollection<
  Row,
  WP extends ResourceParams,
  PP extends ResourceParams,
  GP extends ResourceParams,
>(spec: UnionCollectionSpec<WP, PP, GP>): CompiledUnion<Row, WP, PP, GP> {
  const label = `unionCollection("${spec.key}")`;
  const fail = (message: string): never => {
    throw new Error(`${label}: ${message}`);
  };
  const db: QueryDb = spec.db ?? (realDb as unknown as QueryDb);

  // ── The outer columns ─────────────────────────────────────────────────────
  const reserved = new Set([spec.keyField, spec.discriminator]);
  const columns: OuterColumn[] = [];
  const byName = new Map<string, OuterColumn>();
  for (const [i, c] of spec.columns.entries()) {
    if (reserved.has(c.name)) {
      fail(
        `"${c.name}" is the key field or the discriminator — the compiler projects those itself (A14), no arm binds them.`,
      );
    }
    if (byName.has(c.name)) fail(`column "${c.name}" is declared twice.`);
    if (!SQL_TYPE_RE.test(c.sqlType)) {
      fail(
        `column "${c.name}" declares sqlType "${c.sqlType}", which is not a Postgres type name (A14) — it is interpolated raw into casts.`,
      );
    }
    const col: OuterColumn = {
      name: c.name,
      alias: `__c${i}`,
      sqlType: c.sqlType,
      nullable: false,
    };
    columns.push(col);
    byName.set(c.name, col);
  }
  const KIND: OuterColumn = {
    name: spec.discriminator,
    alias: "__kind",
    sqlType: "text",
    nullable: false,
  };
  const KEY: OuterColumn = {
    name: spec.keyField,
    alias: "__key",
    sqlType: "text",
    nullable: false,
  };
  byName.set(KIND.name, KIND);
  byName.set(KEY.name, KEY);
  const colOf = (name: string): OuterColumn =>
    byName.get(name) ?? fail(`"${name}" is not a column of the union.`);
  for (const name of spec.sortable) colOf(name);

  // ── The arms ──────────────────────────────────────────────────────────────
  const kinds = new Set<string>();
  const arms: Arm[] = spec.arms.map((a) => {
    const armLabel = `${label} arm "${a.kind}"`;
    if (kinds.has(a.kind)) fail(`two arms are of kind "${a.kind}" (A14).`);
    kinds.add(a.kind);
    const codec = armKeyCodec(a.kind);
    const base = routedBase(a.from, armLabel);
    if (tablePrimary(base.table) !== a.id) {
      fail(
        `arm "${a.kind}"'s id "${a.id.name}" is not the single-column primary key of "${base.name}" (A14) — a row's key encodes its arm's primary key.`,
      );
    }
    for (const name of Object.keys(a.reads)) {
      if (reserved.has(name) || !byName.has(name)) {
        fail(`arm "${a.kind}" reads "${name}", which is not an outer column.`);
      }
    }
    const plan = compileJoins(base, a.joins ?? [], a.id, armLabel);
    const kindLiteral = sql.raw(`'${codec.kind}'::text`);
    const keyExpr = armKeySql(a.kind, a.id);
    const readOf = (col: OuterColumn): ReadColumn | undefined =>
      Object.hasOwn(a.reads, col.name) ? a.reads[col.name] : undefined;
    // Every read produces the column's one type — else `UNION ALL` resolves a
    // common type the cut casts and the row key's text would not agree with.
    for (const col of columns) {
      const read = readOf(col);
      if (read === undefined) continue;
      if (
        canonicalSqlType(plan.sqlTypeOf(read)) !== canonicalSqlType(col.sqlType)
      ) {
        fail(
          `arm "${a.kind}" reads "${col.name}" as ${plan.sqlTypeOf(read)}, but the union's column is ${col.sqlType} — every arm must produce one type (A14).`,
        );
      }
    }
    const valueOf = (col: OuterColumn): ReadColumn => {
      if (col === KIND) return kindLiteral;
      if (col === KEY) return keyExpr;
      return readOf(col) ?? nullOf(col.sqlType);
    };
    const constant = (col: OuterColumn): boolean =>
      col === KIND || (col !== KEY && readOf(col) === undefined);
    const decoderOf = (col: OuterColumn): SqlDecoderLike => {
      if (col === KIND || col === KEY) return String;
      const read = readOf(col);
      if (read === undefined) return nullable(String);
      const dec = decoderOfRead(read);
      return plan.canBeNull(read) ? nullable(dec) : dec;
    };

    // The routed half — `routedReads`, as a single-table arm routes it.
    const projection: Record<string, ReadColumn> = { __id: a.id };
    for (const col of columns) {
      const read = readOf(col);
      if (read !== undefined) projection[col.alias] = read;
    }
    const orderColumns = spec.sortable
      .map((name) => colOf(name))
      .filter((col) => !constant(col) && col !== KEY)
      .map((col) => readOf(col)!);
    const whereReads = [...a.whereReads, ...(a.where ? [a.where] : [])];
    const windowReads = routedReads<WP>({
      label: armLabel,
      base,
      joins: plan,
      projection,
      pk: a.id,
      keyField: "__id",
      where: (params) => allOf([a.where, spec.window.whereOf(params, a.kind)]),
      whereReads,
      orderColumns,
      orderOf: (params) =>
        spec.window
          .orderOf(params)
          .map((k) => colOf(k.name))
          .filter((col) => !constant(col) && col !== KEY)
          .map((col): WindowOrderKey => ({ col: readOf(col)! })),
      db,
    });
    const pointReads = routedReads<PP>({
      label: armLabel,
      base,
      joins: plan,
      projection,
      pk: a.id,
      keyField: "__id",
      where: a.where,
      whereReads: undefined,
      orderColumns: [],
      orderOf: () => [],
      db,
    });
    const groups = planGroupArm<
      { value: unknown; count: number },
      ResourceParams
    >(armLabel, {
      from: a.from,
      ...(a.joins ? { joins: a.joins } : {}),
      hostPk: a.id,
      reads: [...Object.values(projection), ...whereReads],
      query: (params) => {
        const q = groupsOf(params as GP);
        return {
          column: valueOf(colOf(q.groupBy)),
          where: allOf([a.where, q.whereOf(a.kind)]),
          limit: q.limit,
          check: q.check,
        };
      },
      db,
    });
    return {
      kind: a.kind,
      codec,
      base,
      plan,
      pk: a.id,
      where: a.where,
      valueOf,
      constant,
      decoderOf,
      window: {
        routes: windowReads.routes,
        tuple: perParams(
          windowReads.tuple as (p: ResourceParams) => TupleReads,
        ),
      },
      point: {
        routes: pointReads.routes,
        tuple: perParams(pointReads.tuple as (p: ResourceParams) => TupleReads),
      },
      groups,
    };
  });
  const groupsOf = perParams((params: GP) => spec.groups.query(params));

  // Static nullability, over EVERY registered arm (never the surviving ones).
  for (const col of columns) {
    col.nullable = arms.some((arm) => {
      const v = arm.valueOf(col);
      return arm.constant(col) || arm.plan.canBeNull(v);
    });
  }

  // ── Rows ──────────────────────────────────────────────────────────────────
  /** Each arm's row parser, over its aliases (+ the row-key parts). */
  const parserOf = (projected: readonly OuterColumn[], parts: number) => {
    const byKind = new Map<string, ZodParser<Record<string, unknown>>>();
    for (const arm of arms) {
      const projection: Record<string, SqlDecoderLike> = {};
      for (const col of projected) projection[col.alias] = arm.decoderOf(col);
      for (let i = 0; i < parts; i++) projection[`__p${i}`] = nullable(String);
      byKind.set(
        arm.kind,
        decodedRow(projection) as ZodParser<Record<string, unknown>>,
      );
    }
    return z.unknown().transform((raw, ctx): Record<string, unknown> => {
      const kind = (raw as { __kind?: unknown } | null)?.__kind;
      const parser = typeof kind === "string" ? byKind.get(kind) : undefined;
      if (parser === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["__kind"],
          message: `a union row of no registered arm (${String(kind)})`,
        });
        return z.NEVER;
      }
      const out = parser.safeParse(raw);
      if (!out.success) {
        for (const issue of out.error.issues)
          ctx.addIssue({
            ...issue,
            code: z.ZodIssueCode.custom,
            message: `${kind}: ${issue.message}`,
          });
        return z.NEVER;
      }
      return out.data;
    }) as unknown as ZodParser<Record<string, unknown>>;
  };
  const allColumns = [KIND, KEY, ...columns];
  const encode = (row: Record<string, unknown>): Row =>
    (spec.encodeRow ? spec.encodeRow(row) : row) as Row;
  /** A decoded positional row → its named row (row key folded when `parts` > 0). */
  const named = (
    r: Record<string, unknown>,
    parts: number,
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const col of allColumns) out[col.name] = r[col.alias];
    if (parts > 0) {
      const values: (string | null)[] = [];
      for (let i = 0; i < parts; i++)
        values.push(r[`__p${i}`] as string | null);
      const json = JSON.stringify(values);
      out[spec.rowKey.keyField] =
        Buffer.byteLength(json, "utf8") > spec.rowKey.maxKeyBytes ? null : json;
    }
    return out;
  };

  // ── The window ────────────────────────────────────────────────────────────
  /** The tuple's keys: its order, then the row key (unless the order names it). */
  const keysOf = perParams(
    (params: WP): { col: OuterColumn; dir: "asc" | "desc" }[] => {
      const keys = spec.window
        .orderOf(params)
        .map((k) => ({ col: colOf(k.name), dir: k.dir }));
      if (!keys.some((k) => k.col === KEY)) keys.push({ col: KEY, dir: "asc" });
      return keys;
    },
  );
  const survivingOf = perParams((params: WP): Arm[] => {
    const kept = spec.window.armsOf(params);
    return arms.filter((arm) => kept.has(arm.kind));
  });
  /** One arm's cut predicate over ALL the tuple's keys (constants included). */
  const cutWhere = (arm: Arm, params: WP): SQL | undefined => {
    const { after, until } = spec.window.cutsOf(params);
    if (after === undefined && until === undefined) return undefined;
    const keys = keysOf(params);
    const sortKeys: SortKey[] = keys.map((k) => ({
      fieldId: k.col.alias,
      col: arm.valueOf(k.col),
      dir: k.dir,
      nullable: k.col.nullable,
    }));
    const operands = (
      cut: readonly (string | null)[],
      which: string,
    ): unknown[] => {
      if (cut.length !== keys.length) {
        fail(
          `the "${which}" cut has ${cut.length} value(s) for the tuple's ${keys.length} order key(s) — a cut is a row key of exactly this order.`,
        );
      }
      return cut.map((v, i) =>
        v === null ? null : sql`${v}::${sql.raw(keys[i]!.col.sqlType)}`,
      );
    };
    return allOf([
      after !== undefined
        ? seekPredicate(sortKeys, operands(after, "after"))
        : undefined,
      until !== undefined
        ? atOrBeforePredicate(sortKeys, operands(until, "until"))
        : undefined,
    ]);
  };
  /** One arm's subselect of the window. */
  const armSelect = (
    arm: Arm,
    params: WP,
    projected: readonly OuterColumn[],
    opts: { limit: number } | { ids: readonly string[] },
  ): SQL => {
    const t = arm.window.tuple(params);
    const where = allOf([
      t.where,
      cutWhere(arm, params),
      "ids" in opts
        ? anyOf(arm.pk, opts.ids, { invalid: "absent" })
        : undefined,
    ]);
    const parts: SQL[] = [
      sql`SELECT ${sql.join(
        projected.map(
          (c) => sql`${arm.valueOf(c)} AS ${sql.identifier(c.alias)}`,
        ),
        sql`, `,
      )}`,
      sql`FROM ${fromSql(arm.base, arm.plan, t.included, `union arm "${arm.kind}"`)}`,
    ];
    if (where) parts.push(sql`WHERE ${where}`);
    if ("limit" in opts) {
      // Constants order nothing inside one arm; the row key is the arm's own
      // tiebreaker (its text is the outer one's, so the two orders agree).
      const keys: SortKey[] = keysOf(params)
        .filter((k) => !arm.constant(k.col))
        .map((k) => ({
          fieldId: k.col.alias,
          col: arm.valueOf(k.col),
          dir: k.dir,
          nullable: k.col.nullable,
        }));
      parts.push(sql`ORDER BY ${sql.join(orderByClauses(keys), sql`, `)}`);
      parts.push(sql`LIMIT ${opts.limit}`);
    }
    return sql`(${sql.join(parts, sql` `)})`;
  };
  /** The arms' subselects, `UNION ALL`ed — or the typed empty scaffold. */
  const unioned = (selects: SQL[], projected: readonly OuterColumn[]): SQL =>
    selects.length > 0
      ? sql.join(selects, sql` UNION ALL `)
      : sql`(SELECT ${sql.join(
          projected.map(
            (c) => sql`${nullOf(c.sqlType)} AS ${sql.identifier(c.alias)}`,
          ),
          sql`, `,
        )} WHERE false)`;
  const outerKeys = (params: WP): SortKey[] =>
    keysOf(params).map((k) => ({
      fieldId: k.col.alias,
      col: sql`u.${sql.identifier(k.col.alias)}`,
      dir: k.dir,
      nullable: k.col.nullable,
    }));
  const partsSql = (params: WP): SQL[] =>
    keysOf(params).map(
      (k, i) =>
        sql`(u.${sql.identifier(k.col.alias)})::text AS ${sql.identifier(`__p${i}`)}`,
    );

  const fullRows = async (params: WP): Promise<Row[]> => {
    const keys = keysOf(params);
    const limit = spec.window.limitOf(params);
    const selects = survivingOf(params).map((arm) =>
      armSelect(arm, params, allColumns, { limit }),
    );
    const query = sql`SELECT u.*, ${sql.join(partsSql(params), sql`, `)} FROM (${unioned(selects, allColumns)}) AS u ORDER BY ${sql.join(orderByClauses(outerKeys(params)), sql`, `)} LIMIT ${limit}`;
    const rows = await executeRows(db, {
      query,
      row: parserOf(allColumns, keys.length),
      label: `${spec.key}:full`,
    });
    return rows.map((r) => encode(named(r, keys.length)));
  };
  /** Decoded `kind:raw` keys, grouped by arm — an unknown kind or bad key dropped. */
  const byArm = (
    keys: readonly string[],
    among: readonly Arm[],
  ): Map<Arm, string[]> => {
    const out = new Map<Arm, string[]>();
    for (const key of keys) {
      for (const arm of among) {
        const raw = arm.codec.decode(key);
        if (raw === null) continue;
        let list = out.get(arm);
        if (!list) out.set(arm, (list = []));
        list.push(raw);
      }
    }
    return out;
  };
  const scopedRows = async (
    params: WP,
    affected: readonly string[],
  ): Promise<Row[]> => {
    const keys = keysOf(params);
    const grouped = byArm(affected, survivingOf(params));
    if (grouped.size === 0) return [];
    const selects = [...grouped].map(([arm, ids]) =>
      armSelect(arm, params, allColumns, { ids }),
    );
    const query = sql`SELECT u.*, ${sql.join(partsSql(params), sql`, `)} FROM (${sql.join(selects, sql` UNION ALL `)}) AS u`;
    const rows = await executeRows(db, {
      query,
      row: parserOf(allColumns, keys.length),
      label: `${spec.key}:scoped`,
    });
    return rows.map((r) => encode(named(r, keys.length)));
  };
  const windowIdsOf = async (params: WP): Promise<string[]> => {
    const limit = spec.window.limitOf(params);
    const projected = [
      ...new Set([KIND, KEY, ...keysOf(params).map((k) => k.col)]),
    ];
    const selects = survivingOf(params).map((arm) =>
      armSelect(arm, params, projected, { limit }),
    );
    const query = sql`SELECT u."__key" AS "__key" FROM (${unioned(selects, projected)}) AS u ORDER BY ${sql.join(orderByClauses(outerKeys(params)), sql`, `)} LIMIT ${limit}`;
    const rows = await executeRows(db, {
      query,
      row: decodedRow({ __key: String }),
      label: `${spec.key}:ids`,
    });
    return rows.map((r) => r.__key);
  };
  const orderSignatureOf = (row: unknown, params: WP): string =>
    keysOf(params)
      .filter((k) => k.col !== KEY)
      .map(
        (k) =>
          JSON.stringify(
            spec.readField(row as Record<string, unknown>, k.col.name),
          ) ?? "undefined",
      )
      .join("\u0000");
  const windowMembership: KeyedMembership<WP> = {
    kind: "window",
    windowIdsOf,
    orderSignatureOf,
    // The limit `fullRows` and `windowIdsOf` read, and the page family: a
    // fresh page may be derived from rows other pages of its query hold (the
    // runtime's seeded derivation).
    limitOf: (params) => spec.window.limitOf(params),
    familyOf: (params) => spec.window.familyOf(params),
  };
  const usesOf =
    <P extends ResourceParams>(
      surviving: (params: P) => readonly Arm[],
      side: "window" | "point",
    ) =>
    (params: P): ReadonlyMap<string, TupleUse> => {
      const uses = new Map<string, TupleUse>();
      for (const arm of surviving(params)) {
        for (const [id, use] of arm[side].tuple(params).uses)
          uses.set(unionRouteId(arm.kind, id), use);
      }
      return uses;
    };
  const windowPolicy: ScopePolicy<WP> = {
    routes: compiledUnionRoutePlan<WP>(
      arms.map((arm) => ({ kind: arm.kind, routes: arm.window.routes })),
      usesOf<WP>(survivingOf, "window"),
    ),
    membership: windowMembership,
  };
  const window = {
    loader: (params: WP, ctx?: { affectedIds: readonly string[] }) =>
      ctx ? scopedRows(params, ctx.affectedIds) : fullRows(params),
    ...windowPolicy,
    ...(spec.window.validateParams
      ? { validateParams: spec.window.validateParams }
      : {}),
  } as KeyedServerResourceOptions<Row[], WP> & ScopePolicy<WP>;

  // ── The point read (`:rows`) ──────────────────────────────────────────────
  const pointRows = async (
    params: PP,
    ids: readonly string[],
  ): Promise<Row[]> => {
    const grouped = byArm(ids, arms);
    if (grouped.size === 0) return [];
    const selects = [...grouped].map(([arm, raw]) => {
      const t = arm.point.tuple(params);
      const where = allOf([t.where, anyOf(arm.pk, raw, { invalid: "absent" })]);
      return sql`(SELECT ${sql.join(
        allColumns.map(
          (c) => sql`${arm.valueOf(c)} AS ${sql.identifier(c.alias)}`,
        ),
        sql`, `,
      )} FROM ${fromSql(arm.base, arm.plan, t.included, `union arm "${arm.kind}"`)} WHERE ${where})`;
    });
    const query = sql`SELECT u.* FROM (${sql.join(selects, sql` UNION ALL `)}) AS u`;
    const rows = await executeRows(db, {
      query,
      row: parserOf(allColumns, 0),
      label: `${spec.key}:rows`,
    });
    return rows.map((r) => encode(named(r, 0)));
  };
  const rowsPolicy: ScopePolicy<PP> = {
    routes: compiledUnionRoutePlan<PP>(
      arms.map((arm) => ({ kind: arm.kind, routes: arm.point.routes })),
      usesOf<PP>(() => arms, "point"),
    ),
    membership: { kind: "point", idsOf: (params) => spec.point.idsOf(params) },
  };
  const rows = {
    loader: async (params: PP, ctx?: { affectedIds: readonly string[] }) => {
      const ids = ctx?.affectedIds ?? spec.point.idsOf(params);
      return ids.length === 0 ? [] : pointRows(params, ids);
    },
    ...rowsPolicy,
  } as KeyedServerResourceOptions<Row[], PP> & ScopePolicy<PP>;

  // ── The groups (`:groups`) ────────────────────────────────────────────────
  const groupRoutes: FullRoute[] = arms.flatMap((arm) =>
    arm.groups.routes.map((r) => ({ ...r, id: unionRouteId(arm.kind, r.id) })),
  );
  const groupArmsOf = (params: GP): Arm[] => {
    const q = groupsOf(params);
    return arms.filter((arm) => q.arms.has(arm.kind));
  };
  const groups: CompiledGroups<{ value: unknown; count: number }, GP> = {
    mode: "push",
    loader: async (params: GP) => {
      const q = groupsOf(params);
      const col = colOf(q.groupBy);
      const surviving = groupArmsOf(params);
      if (surviving.length === 0) return [];
      const selects = surviving.map((arm) => {
        const t = arm.groups.tuple(params);
        const parts: SQL[] = [
          sql`SELECT ${arm.valueOf(col)} AS "value", count(*)::integer AS "count"`,
          sql`FROM ${fromSql(arm.base, arm.plan, t.included, `union arm "${arm.kind}"`)}`,
        ];
        if (t.q.where) parts.push(sql`WHERE ${t.q.where}`);
        parts.push(sql`GROUP BY 1`);
        return sql`(${sql.join(parts, sql` `)})`;
      });
      const reader = arms.find((arm) => !arm.constant(col));
      const decoder: SqlDecoderLike =
        col === KIND || reader === undefined
          ? nullable(String)
          : nullable(decoderOfRead(reader.valueOf(col)));
      const query = sql`SELECT g."value" AS "value", sum(g."count")::integer AS "count" FROM (${sql.join(selects, sql` UNION ALL `)}) AS g GROUP BY g."value" ORDER BY 2 DESC, 1 ASC NULLS LAST LIMIT ${q.limit}`;
      const out = await executeRows(db, {
        query,
        row: decodedRow({ value: decoder, count: Number }),
        label: `${spec.key}:groups`,
      });
      for (const r of out) if (r.value !== null) q.check(r.value);
      return out;
    },
    reach: compiledReachPlan<GP>(groupRoutes, (params) => {
      const uses = new Map<string, TupleUse>();
      for (const arm of groupArmsOf(params)) {
        for (const [id, use] of arm.groups.tuple(params).uses)
          uses.set(unionRouteId(arm.kind, id), use);
      }
      return uses;
    }),
  };
  return { window, rows, groups };
}
