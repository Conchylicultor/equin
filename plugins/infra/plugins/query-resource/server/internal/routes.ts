import { getTableColumns, is } from "drizzle-orm";
import {
  PgTable,
  PgView,
  getTableConfig,
  type PgColumn,
} from "drizzle-orm/pg-core";
import {
  mintReachPlan,
  mintRoutePlan,
  type DerivedRead,
  type FullRoute,
  type HostMap,
  type ReachPlan,
  type ResourceParams,
  type Route,
  type RoutePlan,
  type TupleUse,
} from "@plugins/framework/plugins/resource-runtime/core";
import {
  armKeyCodec,
  BASE_RELATION,
  type ArmKeyCodec,
} from "@plugins/infra/plugins/query-resource/core";
import type { EntitySource, RoutedSource } from "./spec";

// The routed half of a compiled read: the `RoutePlan` (or, for a non-keyed
// aggregate, the `ReachPlan`) the runtime's `routeTableChange` serves the
// resource by — see research/2026-09-29-global-scoped-change-routing.md. Emitted
// from the same declaration the SQL is rendered from, so the tables a query
// reads and the tables its routes name cannot disagree (the runtime's drift
// guard, A8, checks the captured read-set against them all the same).
//
// A compiled read is its base table (route `base`, an `identity` route every
// tuple reads as membership) plus its declared joins (one route each, named by
// the join's alias — `./joins`), and a tuple's `usesOf` names exactly the
// relations its SQL joins.
//
// This module is the one production minter of plans (`mintRoutePlan` /
// `mintReachPlan` — the `resource-runtime:compiled-routes` check): a route's
// `columns` gate which updates reach the resource, so only the code that writes
// the SQL may state them.

/** The base table's route id — its `ColumnRef` relation name too. */
export const BASE_ROUTE_ID = BASE_RELATION;

/** The base table a routed compile reads — never a view (A1). */
export interface RoutedBase {
  table: PgTable;
  /** The table's name: the only name a change to it ever arrives under. */
  name: string;
}

/**
 * The base table of a routed compile. A view has no trigger — a change arrives
 * under its base tables' names, which a view declaration cannot state as
 * routes — so a routed resource reads tables (A1): `RoutedSource` has no
 * spelling for a view, and one cast through throws here.
 */
export function routedBase(from: RoutedSource, label: string): RoutedBase {
  if (is(from, PgView)) {
    throw new Error(
      `${label}: a routed compile reads a base table, never a view — a change ` +
        `arrives under its base tables' names, which no route of a view can ` +
        `state. Read the base table (an entity, or the pgTable itself).`,
    );
  }
  const table = is(from, PgTable) ? from : (from as EntitySource).table;
  return { table, name: getTableConfig(table).name };
}

/**
 * The table's single-column primary key — inline (`.primaryKey()`) or declared
 * table-level (`primaryKey({ columns })`) — or null (composite / none): the one
 * key the change feed sends as `ids`.
 */
export function tablePrimary(table: PgTable): PgColumn | null {
  const columns = Object.values(
    getTableColumns(table) as Record<string, PgColumn>,
  );
  const declared = getTableConfig(table).primaryKeys;
  if (declared.length > 0) {
    const only = declared.length === 1 ? declared[0]!.columns : [];
    // The declaration's columns are built apart from the table's own column
    // objects: resolve the name back to the table's.
    return only.length === 1
      ? (columns.find((c) => c.name === only[0]!.name) ?? null)
      : null;
  }
  const primaries = columns.filter((c) => c.primary);
  return primaries.length === 1 ? primaries[0]! : null;
}

/**
 * The base table's route in a keyed read whose host ids are the values of
 * `pk`: an `identity` route. When `pk` IS the table's primary key the change
 * feed's ids are the host ids as they stand; otherwise the route reads `pk` off
 * the change's key layout, and a change that carries none recomputes its readers
 * FULL (correct, not scoped). Every tuple reads it as membership: a row write
 * may move it in or out.
 */
export function baseIdentityRoute(
  base: RoutedBase,
  pk: PgColumn,
  columns: readonly string[],
): RawRoute {
  return {
    id: BASE_ROUTE_ID,
    table: base.name,
    map:
      tablePrimary(base.table) === pk
        ? { kind: "identity" }
        : { kind: "identity", column: pk.name },
    columns,
  };
}

/**
 * A route as one compile's SQL emits it, before any union: its `identity` and
 * `alias` maps name RAW host ids — `encode` is never set (T10). Only
 * `compiledUnionRoutePlan` encodes them (into its arms' `kind:raw` key space),
 * and it encodes a `reverse` answer and decodes its `within` at the same time,
 * so a reverse probe can never read or answer the wrong key space: a single
 * compile cannot spell an encoded route at all.
 */
export type RawHostMap =
  | { kind: "identity"; column?: string; encode?: never }
  | { kind: "alias"; column?: string; encode?: never }
  | Extract<HostMap, { kind: "reverse" | "full" }>;

/** A route whose maps name raw host ids (see {@link RawHostMap}). */
export type RawRoute = Omit<Route, "map"> & { map: RawHostMap };

/**
 * Mint a keyed compile's plan over its raw routes (one key space: the base
 * table's own ids), with the derived tables (rollups) its SQL reads beside
 * them — `routedReads`' `derivedReads`, minted only when non-empty, and
 * checked by `mintRoutePlan` (A1, A22).
 */
export function compiledRoutePlan<P extends ResourceParams>(
  routes: readonly RawRoute[],
  usesOf: (params: P) => ReadonlyMap<string, TupleUse>,
  derivedReads: readonly DerivedRead[] = [],
  /**
   * The L2 definition (A18) of a persisted compile — the `all` compiler's
   * fingerprint (`./fingerprint`). Absent for every bounded compile, which is
   * never persisted.
   */
  definition?: string,
): RoutePlan<P> {
  return mintRoutePlan({
    routes,
    usesOf,
    ...(derivedReads.length > 0 ? { derivedReads } : {}),
    ...(definition !== undefined ? { definition } : {}),
  });
}

/** One arm of a union compile, as its routes are minted: its kind and its raw routes. */
export interface UnionArmRoutes {
  kind: string;
  routes: readonly RawRoute[];
}

/**
 * An arm's route id in the union plan: its base route is `<kind>`, any other
 * `<kind>.<id>` — unique across arms because a kind never contains a `.`.
 */
export function unionRouteId(kind: string, routeId: string): string {
  return routeId === BASE_ROUTE_ID ? kind : `${kind}.${routeId}`;
}

/**
 * Mint a union compile's plan (P6): every arm's raw routes, re-keyed into the
 * union's `kind:raw` row-key space through the arm's `armKeyCodec`.
 *
 * - route ids are prefixed (`unionRouteId`) and must stay unique (A14);
 * - an `identity` route must read the base table's own primary key (no
 *   `column`): an arm's raw id IS its pk, which is what the key encodes;
 * - `identity` and `alias` maps gain the arm's `encode`;
 * - a `reverse` map's `resolve` decodes `within` to THIS arm's raw ids
 *   (another arm's keys dropped; an empty set skips the probe — no host of
 *   this arm can be held; `null` passes through, an unbounded reader), probes,
 *   and encodes the answer; `"over-cap"` passes through;
 * - a `full` map is the same for every key space.
 *
 * `usesOf` answers in the PREFIXED route ids — the union compiler's own.
 */
export function compiledUnionRoutePlan<P extends ResourceParams>(
  arms: readonly UnionArmRoutes[],
  usesOf: (params: P) => ReadonlyMap<string, TupleUse>,
): RoutePlan<P> {
  const kinds = new Set<string>();
  const ids = new Set<string>();
  const routes: Route[] = [];
  for (const arm of arms) {
    if (kinds.has(arm.kind)) {
      throw new Error(
        `union route plan: two arms of kind "${arm.kind}" — a kind is a row key's prefix, so it names one arm`,
      );
    }
    kinds.add(arm.kind);
    const codec = armKeyCodec(arm.kind);
    for (const route of arm.routes) {
      const id = unionRouteId(arm.kind, route.id);
      if (ids.has(id)) {
        throw new Error(
          `union route plan: route id "${id}" is minted twice — an arm's route ids must be unique across the union`,
        );
      }
      ids.add(id);
      routes.push({ ...route, id, map: encodedMap(arm.kind, route, codec) });
    }
  }
  return mintRoutePlan({ routes, usesOf });
}

function encodedMap(
  kind: string,
  route: RawRoute,
  codec: ArmKeyCodec,
): HostMap {
  const map = route.map;
  switch (map.kind) {
    case "identity":
      if (map.column !== undefined) {
        throw new Error(
          `union route plan: arm "${kind}"'s identity route "${route.id}" reads "${map.column}" — an arm's id is its base table's single-column primary key, read off the change's ids`,
        );
      }
      return { kind: "identity", encode: codec.encode };
    case "alias":
      return {
        kind: "alias",
        ...(map.column === undefined ? {} : { column: map.column }),
        encode: codec.encode,
      };
    case "reverse": {
      const resolve = map.resolve;
      return {
        kind: "reverse",
        ...(map.column === undefined ? {} : { column: map.column }),
        resolve: async (changed, within, cap) => {
          let raw: Set<string> | null = null;
          if (within !== null) {
            raw = new Set<string>();
            for (const key of within) {
              const id = codec.decode(key);
              if (id !== null) raw.add(id);
            }
            // No host of this arm is held: nothing it could answer is kept.
            if (raw.size === 0) return [];
          }
          const answer = await resolve(changed, raw, cap);
          return answer === "over-cap" ? answer : answer.map(codec.encode);
        },
      };
    }
    case "full":
      return map;
  }
}

/**
 * What a hand-written loader declares it reads (a served value's `reads` —
 * `network/live`'s `serveValue`). Whole tables only: a loader's SQL is not
 * compiled here, so nothing could keep a per-row filter in step with it — a
 * write to any row of a declared table recomputes every tuple. Row-level
 * narrowing exists only where the SQL is compiled from the same declaration
 * (a collection).
 */
export interface ValueReads {
  /** Every table the loader reads — base tables or entities, never a view (A1). */
  tables: readonly RoutedSource[];
  /** Why a write to any row of them may change any tuple (the pane shows it). */
  reason: string;
  /**
   * Tables the loader reads that the change feed skips by declaration
   * (`ExcludeFromChangeFeed`) — a bulk cache read through a memo keyed on a
   * table it does route. Accepted by the drift guard, never routed; change-feed
   * refuses at boot one it does cover.
   */
  outsideFeed?: { tables: readonly RoutedSource[]; reason: string };
}

/**
 * A served value's plan from its declared `reads`: one `full` route per table,
 * reading every column (so no update is skipped by the gate — a hand-written
 * loader's columns are unknown), read by every tuple. The drift guard (A8)
 * holds the loader to it: a captured table outside it is reported and, in a
 * running server, routed FULL from then on.
 */
export function compiledValueReach<P extends ResourceParams>(
  reads: ValueReads,
  label: string,
): ReachPlan<P> {
  const where = `${label}: reads`;
  if (reads.reason.trim() === "") {
    throw new Error(
      `${where}.reason is empty — say why a write to any row may change any tuple.`,
    );
  }
  const routes: FullRoute[] = [];
  for (const source of reads.tables) {
    const base = routedBase(source, label);
    if (routes.some((r) => r.table === base.name)) {
      throw new Error(`${where}.tables lists "${base.name}" twice.`);
    }
    routes.push({
      id: base.name,
      table: base.name,
      map: { kind: "full", reason: reads.reason },
      columns: Object.values(
        getTableColumns(base.table) as Record<string, PgColumn>,
      ).map((c) => c.name),
    });
  }
  const outside = reads.outsideFeed;
  if (outside !== undefined && outside.tables.length === 0) {
    throw new Error(`${where}.outsideFeed.tables is empty — omit it.`);
  }
  const unfed = (outside?.tables ?? []).map((source) => ({
    table: routedBase(source, label).name,
    reason: outside!.reason,
  }));
  const uses: ReadonlyMap<string, TupleUse> = new Map(
    routes.map((r) => [r.id, { role: "membership" as const }]),
  );
  return mintReachPlan<P>({ routes, usesOf: () => uses, unfed });
}

/**
 * Mint a non-keyed aggregate's plan (a collection's `:groups`): `full` routes
 * only — any written row may move any count, so a relevant change recomputes
 * the tuple, and a change to a table the tuple does not read reaches nothing.
 */
export function compiledReachPlan<P extends ResourceParams>(
  routes: readonly FullRoute[],
  usesOf: (params: P) => ReadonlyMap<string, TupleUse>,
): ReachPlan<P> {
  return mintReachPlan({ routes, usesOf });
}
