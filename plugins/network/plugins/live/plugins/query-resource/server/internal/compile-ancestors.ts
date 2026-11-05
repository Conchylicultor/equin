import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db as realDb } from "@plugins/database/server";
import { decodedRow } from "@plugins/database/plugins/sql-projection/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import type {
  KeyedMembership,
  KeyedServerResourceOptions,
  ScopePolicy,
  TupleUse,
} from "@plugins/network/plugins/live/plugins/resource-runtime/core";
import type { PointParams } from "@plugins/network/plugins/live/plugins/live-state/core";
import {
  BASE_RELATION,
  type PointQueryResourceContract,
} from "@plugins/network/plugins/live/plugins/query-resource/core";
import { planArm } from "./arm-plan";
import { anyOf } from "./raw-sql";
import { compiledRoutePlan, routedBase } from "./routes";
import type { PointQueryResourceSpec, QueryDb } from "./spec";

// The ANCESTORS compile: a tree collection's `${key}:ancestors` sibling
// (network/live's `liveCollection(key, { tree })`). A tuple names a set of
// SEED ids (the point codec); its value is the seeds and every ancestor of
// them up the `parent` column — the closure — in one round trip (a recursive
// CTE), each row projected exactly as the collection's `:rows` projects it.
//
// It is the point spec's relation set (`planArm`'s point arm: projection,
// joins, routes, the static `where`) under a WINDOW membership whose ids are
// the closure:
//
// - `windowIdsOf` = the closure's ids (the CTE);
// - the FULL loader reads the rows of the closure, the scoped refill those of
//   `closure ∩ affectedIds` — so a refilled row outside the closure (a
//   write to a row no seed descends from) is no entrant;
// - the order signature is a row's `parent`: a member re-pointed elsewhere
//   re-derives the closure (old ancestors leave, new ones enter, backfilled);
//   a rename or any other column refills the row in place;
// - the base route's membership `moves` add `parent`, so a write touching
//   neither it nor the `where` reaches only the rows the tuple holds;
// - `limitOf` is 0: a closure is no prefix of an order, so no exit is local —
//   a leaver (a deleted ancestor) may take its own ancestors with it, and
//   every exit re-derives (the runtime's "full window" path).
//
// Bounded: the seeds by the point codec (`maxIds`), the walk by `maxDepth`
// (a chain reaching it is a loud loader error, and so is a cycle), the
// answer by `maxRows` (loud past it). The walk stops at a row outside the
// static `where` (it is not in the collection), which must therefore read
// the base table alone.

/** What the closure walks: the parent column and the bounds. */
export interface AncestorsClosure {
  /** The base column naming a row's parent (its id; `NULL` at a root). */
  parent: PgColumn;
  /** The most rows one tuple answers (the descriptor's `.max`). */
  maxRows: number;
  /** The deepest chain walked: one reaching it is a loud error. */
  maxDepth: number;
}

/** The compiled server half of a `:ancestors` resource, ready for `defineResource`. */
export interface CompiledAncestors<Row> {
  serverOpts: KeyedServerResourceOptions<Row[], PointParams> &
    ScopePolicy<PointParams>;
  keyField: string;
}

/**
 * Compile a tree collection's `:ancestors` read from its `:rows` point spec
 * (the same projection, joins and `where`) and the closure it walks. Every
 * misuse throws here, at module eval.
 */
export function compileAncestorsQuery<Row>(
  descriptor: PointQueryResourceContract<Row>,
  spec: PointQueryResourceSpec<PointParams>,
  closure: AncestorsClosure,
): CompiledAncestors<Row> {
  const key = descriptor.key;
  const label = `compileAncestorsQuery("${key}")`;
  const fail = (message: string): never => {
    throw new Error(`${label}: ${message}`);
  };
  const db: QueryDb = spec.db ?? (realDb as unknown as QueryDb);
  const base = routedBase(spec.from, label);
  const { parent, maxRows, maxDepth } = closure;
  const where =
    typeof spec.where === "function"
      ? fail(
          "the `where` is per tuple — an ancestors read has one membership, the collection's static `where`.",
        )
      : spec.where;
  if (parent.table !== base.table) {
    fail(
      `its parent column "${parent.name}" is not a column of "${base.name}" — the closure walks the base table.`,
    );
  }
  const arm = planArm<Row, PointParams>({
    key,
    label,
    base,
    from: spec.from,
    identity: { pk: spec.point.by },
    ...(spec.select !== undefined ? { select: spec.select } : {}),
    ...(spec.joins !== undefined ? { joins: spec.joins } : {}),
    where,
    // The parent column gates the base route: a re-pointed row must reach
    // the tuple, projected or not.
    whereReads: [...(where === undefined ? [] : [where]), parent],
    db,
    mode: { kind: "point" },
  });
  const pk = arm.pkColumn;
  if (parent === pk) fail(`its parent column "${parent.name}" is the id.`);
  if (parent.getSQLType() !== pk.getSQLType()) {
    fail(
      `its parent column "${parent.name}" is ${parent.getSQLType()}, the id "${pk.name}" ${pk.getSQLType()} — a parent names a row by its id.`,
    );
  }
  // The walk reads the base table by name, unaliased: its `where` may name no
  // join (a join's alias is not in the CTE's scope).
  if (where !== undefined) {
    for (const [relation] of arm.joins.columnsIn(where)) {
      if (relation !== BASE_RELATION) {
        fail(
          `the \`where\` reads join "${relation}" — the closure walk reads the base table alone, so a tree collection's \`where\` names base columns only.`,
        );
      }
    }
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
    fail(`maxDepth must be a positive integer, got ${maxDepth}.`);
  }

  const table = base.table;
  const scope = where === undefined ? sql`` : sql` AND ${where}`;
  const closureSql = (seeds: readonly string[]): SQL =>
    sql`WITH RECURSIVE __up(__id, __parent, __depth, __path, __cycle) AS (SELECT ${pk}, ${parent}, 0, ARRAY[${pk}::text], false FROM ${table} WHERE ${anyOf(pk, seeds, { invalid: "absent" })}${scope} UNION ALL SELECT ${pk}, ${parent}, __up.__depth + 1, __up.__path || ${pk}::text, ${pk}::text = ANY(__up.__path) FROM __up JOIN ${table} ON ${pk} = __up.__parent WHERE NOT __up.__cycle AND __up.__depth < ${maxDepth}${scope}) SELECT __id::text AS __id, (__parent IS NOT NULL) AS __has_parent, __depth, __cycle FROM __up`;
  const closureRow = decodedRow({
    __id: String,
    __has_parent: Boolean,
    __depth: Number,
    __cycle: Boolean,
  });

  /** The closure of `seeds`: its ids, each once, in the walk's order. */
  const closureIds = async (seeds: readonly string[]): Promise<string[]> => {
    if (seeds.length === 0) return [];
    const rows = await executeRows(db, {
      query: closureSql(seeds),
      row: closureRow,
      label: `${key}:closure`,
    });
    const ids = new Set<string>();
    for (const r of rows) {
      if (r.__cycle) {
        throw new Error(
          `${label}: the parent chain above "${r.__id}" is a cycle — a tree's parent column must never lead back to a row.`,
        );
      }
      if (r.__depth >= maxDepth && r.__has_parent) {
        throw new Error(
          `${label}: the parent chain above "${r.__id}" reaches ${maxDepth} levels — deeper than an ancestors read walks.`,
        );
      }
      ids.add(r.__id);
    }
    if (ids.size > maxRows) {
      throw new Error(
        `${label}: ${ids.size} rows in the closure of ${seeds.length} seed(s), at most ${maxRows} — read fewer seeds per tuple.`,
      );
    }
    return [...ids];
  };

  const encodeRow = spec.encodeRow;
  const encoded = (rows: Row[]): Row[] =>
    encodeRow
      ? rows.map((r) => encodeRow(r as Record<string, unknown>) as Row)
      : rows;
  const rowsOf = async (
    params: PointParams,
    ids: readonly string[],
  ): Promise<Row[]> => {
    if (ids.length === 0) return [];
    const rows = arm.fold(await arm.pointQuery(params, ids), params);
    // In the closure's order, so a full load and `windowIdsOf` agree.
    const at = new Map(ids.map((id, i) => [id, i]));
    const keyOf = (r: Row) =>
      at.get(String((r as Record<string, unknown>)[arm.keyField])) ?? 0;
    return encoded(rows.sort((a, b) => keyOf(a) - keyOf(b)));
  };
  const seedsOf = (params: PointParams): string[] =>
    descriptor.point.decode(params);

  const loader = async (
    params: PointParams,
    ctx?: { affectedIds: readonly string[] },
  ): Promise<Row[]> => {
    const members = await closureIds(seedsOf(params));
    if (ctx === undefined) return rowsOf(params, members);
    const affected = new Set(ctx.affectedIds);
    return rowsOf(
      params,
      members.filter((id) => affected.has(id)),
    );
  };
  const parentField = Object.entries(spec.select ?? {}).find(
    ([, read]) => read === parent,
  )?.[0];
  // The signature is the row's parent as projected; a tree's parent is a
  // row field (`liveCollection` checks it), so it is.
  if (parentField === undefined) {
    fail(
      `its parent column "${parent.name}" is not projected — the order signature reads it off the row.`,
    );
  }
  const membership: KeyedMembership<PointParams> = {
    kind: "window",
    windowIdsOf: (params) => closureIds(seedsOf(params)),
    orderSignatureOf: (row) =>
      JSON.stringify((row as Record<string, unknown>)[parentField!] ?? null),
    limitOf: () => 0,
  };
  // The base use moves on the parent too: a re-pointed row may leave or
  // bring in ancestors.
  const usesOf = (params: PointParams): ReadonlyMap<string, TupleUse> => {
    const uses = new Map(arm.tuple(params).uses);
    const own = uses.get(BASE_RELATION);
    if (own?.role === "membership" && own.moves !== undefined) {
      uses.set(BASE_RELATION, {
        ...own,
        moves: [...new Set([...own.moves, parent.name])].sort(),
      });
    }
    return uses;
  };
  const scopePolicy: ScopePolicy<PointParams> = {
    routes: compiledRoutePlan<PointParams>(arm.routes, usesOf),
    membership,
  };
  const serverOpts = {
    loader,
    ...scopePolicy,
    ...(spec.debounceMs != null ? { debounceMs: spec.debounceMs } : {}),
  } as KeyedServerResourceOptions<Row[], PointParams> &
    ScopePolicy<PointParams>;
  if (descriptor.queryPk !== arm.keyField) {
    fail(
      `the descriptor keys on "${String(descriptor.queryPk)}", the query on "${arm.keyField}".`,
    );
  }
  return { serverOpts, keyField: arm.keyField };
}
