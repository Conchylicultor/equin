import { getTableColumns, is } from "drizzle-orm";
import {
  PgTable,
  PgView,
  getTableConfig,
  getViewConfig,
  type PgColumn,
} from "drizzle-orm/pg-core";
import {
  mintReachPlan,
  mintRoutePlan,
  type DerivedRead,
  type FullRoute,
  type HostMap,
  type ReachPlan,
  type RelationRead,
  type ResourceParams,
  type Route,
  type RoutePlan,
  type TaggedRead,
  type TupleUse,
} from "@plugins/framework/plugins/resource-runtime/core";
import {
  armKeyCodec,
  BASE_RELATION,
  type ArmKeyCodec,
} from "@plugins/infra/plugins/query-resource/core";
import type { EntitySource, RoutedSource } from "./spec";
import { isLookupRead, type LookupRead } from "./compile-lookup";

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
 *
 * `match` names the base columns a tuple's use may match on (a scoped `all`
 * set's `by` columns): the change feed then carries them as keys (old ∪ new,
 * so a moved row names both its scopes), and a tuple matching another value
 * is skipped before any load. Declared only when non-empty, so every other
 * route keeps its shape.
 */
export function baseIdentityRoute(
  base: RoutedBase,
  pk: PgColumn,
  columns: readonly string[],
  opts: { match?: readonly string[] } = {},
): RawRoute {
  const match = opts.match ?? [];
  return {
    id: BASE_ROUTE_ID,
    table: base.name,
    map:
      tablePrimary(base.table) === pk
        ? { kind: "identity" }
        : { kind: "identity", column: pk.name },
    columns,
    ...(match.length === 0 ? {} : { match }),
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
 * `network/live`'s `serveValue`). Two kinds:
 *
 * - `tables` — WHOLE: the loader's SQL is not compiled here, so nothing could
 *   keep a per-row filter (or a column gate) in step with it — a write to any
 *   column of any row of a declared table recomputes every tuple.
 * - `lookups` — compiled: a by-key read the loader runs through
 *   `compileLookup`'s `run`, whose SQL and routes come from one declaration —
 *   so a write reaches only the tuples asking about the row it touched, and
 *   only when it touched a column the lookup reads.
 *
 * Row-level narrowing exists only where the SQL is compiled from the same
 * declaration: a lookup, or a collection.
 */
export interface ValueReads<P extends ResourceParams = ResourceParams> {
  /**
   * Every relation the loader reads whole — base tables, entities, or views.
   * A view has no trigger, so it is no route: it is a relation read
   * (`RelationRead`) the runtime reaches through its base tables once they
   * are known, and the drift guard accepts under its own name. Empty when
   * everything the loader reads is a lookup or `outsideFeed`.
   */
  tables: readonly (RoutedSource | PgView)[];
  /**
   * The compiled lookups the loader reads through (`compileLookup(…).read`),
   * each read ONLY through its `run`: its tables are covered in the loader's
   * capture by its tagged statement alone (resource-runtime's `TaggedRead`),
   * so a loader that reads one of them another way is drift. A table is
   * listed in `tables` or reached by lookups, never both.
   */
  lookups?: readonly LookupRead<P>[];
  /** Why a write to any row of `tables` may change any tuple (the pane shows it). */
  reason: string;
  /**
   * Tables the loader reads that the change feed skips by declaration
   * (`ExcludeFromChangeFeed`) — a bulk cache read through a memo keyed on a
   * table it does route. Accepted by the drift guard, never routed; change-feed
   * refuses at boot one it does cover.
   */
  outsideFeed?: { tables: readonly RoutedSource[]; reason: string };
  /**
   * Relations (views or tables) the loader reads whose changes reach the value
   * through its OWN notify — a domain event that owns them, wired to the
   * value's `notify` — not through the change feed (resource-runtime's
   * `NotifiedRead`). Never routed, never indexed under a view's bases, so a
   * write to them recomputes nothing by itself; the drift guard accepts them.
   * Only an external `"notified"` value may declare them (network/live types
   * it; the runtime throws on a DB-backed entry). A relation is in `tables`,
   * a lookup or here, never two of them.
   */
  notified?: { relations: readonly (RoutedSource | PgView)[]; reason: string };
}

/**
 * A served value's plan from its declared `reads`: one `full` route per
 * table, reading every column (so no update is skipped by the gate — a
 * hand-written loader's columns are unknown), read by every tuple; one
 * relation read per view, with the same reason; and each lookup's own routes
 * — `full`, gated by the columns its SQL reads, matched per tuple — with its
 * tables tagged (covered only by its own statement). The drift guard (A8)
 * holds the loader to it: a captured table outside it is reported and, in a
 * running server, routed FULL from then on. Serves a non-keyed value and an
 * external keyed one (a paged value's pages) alike: every route is `full`.
 */
export function compiledValueReach<P extends ResourceParams>(
  reads: ValueReads<P>,
  label: string,
): ReachPlan<P> {
  const where = `${label}: reads`;
  if (reads.reason.trim() === "") {
    throw new Error(
      `${where}.reason is empty — say why a write to any row may change any tuple.`,
    );
  }
  const routes: FullRoute[] = [];
  const relations: RelationRead[] = [];
  const listed = new Set<string>();
  const once = (name: string) => {
    if (listed.has(name)) {
      throw new Error(`${where}.tables lists "${name}" twice.`);
    }
    listed.add(name);
  };
  for (const source of reads.tables) {
    if (is(source, PgView)) {
      const relation = getViewConfig(source).name;
      once(relation);
      relations.push({ relation, reason: reads.reason });
      continue;
    }
    const base = routedBase(source, label);
    once(base.name);
    routes.push({
      id: base.name,
      table: base.name,
      map: { kind: "full", reason: reads.reason },
      columns: Object.values(
        getTableColumns(base.table) as Record<string, PgColumn>,
      ).map((c) => c.name),
    });
  }
  const whole = routes.length;
  const lookups = reads.lookups ?? [];
  const taggedReads: TaggedRead[] = [];
  const lookupLabels = new Set<string>();
  for (const lookup of lookups) {
    // Minted only by `compileLookup`: its routes' columns gate updates.
    if (!isLookupRead(lookup)) {
      throw new Error(
        `${where}.lookups holds a read compileLookup did not mint — a lookup's routes gate updates, so only its compile may state them.`,
      );
    }
    if (lookupLabels.has(lookup.label)) {
      throw new Error(`${where}.lookups lists "${lookup.label}" twice.`);
    }
    lookupLabels.add(lookup.label);
    for (const route of lookup.routes) {
      if (listed.has(route.table)) {
        throw new Error(
          `${where}: "${route.table}" is read whole (\`tables\`) and through the lookup "${lookup.label}" — the whole-table route would reach every write the lookup's gates skip. List it in one place.`,
        );
      }
      routes.push(route);
      taggedReads.push({ table: route.table, tag: lookup.label });
    }
  }
  const outside = reads.outsideFeed;
  if (outside !== undefined && outside.tables.length === 0) {
    throw new Error(`${where}.outsideFeed.tables is empty — omit it.`);
  }
  const unfed = (outside?.tables ?? []).map((source) => ({
    table: routedBase(source, label).name,
    reason: outside!.reason,
  }));
  const announced = reads.notified;
  if (announced !== undefined && announced.relations.length === 0) {
    throw new Error(`${where}.notified.relations is empty — omit it.`);
  }
  // A relation also routed or read whole is refused by `mintReachPlan`.
  const notified = (announced?.relations ?? []).map((source) => ({
    relation: is(source, PgView)
      ? getViewConfig(source).name
      : routedBase(source, label).name,
    reason: announced!.reason,
  }));
  const wholeUses: ReadonlyMap<string, TupleUse> = new Map(
    routes.slice(0, whole).map((r) => [r.id, { role: "membership" as const }]),
  );
  const usesOf =
    lookups.length === 0
      ? () => wholeUses
      : (params: P): ReadonlyMap<string, TupleUse> => {
          const uses = new Map(wholeUses);
          for (const lookup of lookups) {
            for (const [id, use] of lookup.usesOf(params)) uses.set(id, use);
          }
          return uses;
        };
  return mintReachPlan<P>({
    routes,
    usesOf,
    unfed,
    relations,
    ...(notified.length > 0 ? { notified } : {}),
    ...(taggedReads.length > 0 ? { taggedReads } : {}),
  });
}

/**
 * The reach plan of a compile served OFF the change feed whose SQL reads
 * `tables` (an external keyed window / point set — network/live's
 * `serveCollection` with `changes` — whose loader is the compiled SQL): every
 * one `unfed`, no route — so the drift guard accepts the loader's reads, and
 * change-feed's boot check holds each table to its opt-out
 * (`ExcludeFromChangeFeed`).
 */
export function offFeedTablesReach<P extends ResourceParams>(
  tables: readonly string[],
  reason: string,
): ReachPlan<P> {
  const none: ReadonlyMap<string, TupleUse> = new Map();
  return mintReachPlan<P>({
    routes: [],
    usesOf: () => none,
    unfed: [...new Set(tables)].map((table) => ({ table, reason })),
  });
}

/**
 * A compiled non-keyed aggregate (a collection's `:groups` / `:count`) served
 * OFF the change feed (network/live's `serveCollection` with `changes`): the
 * same SQL, its change its own `notify`. Every table its routed `reach` names
 * becomes an `unfed` read and no route remains — so the drift guard accepts
 * the loader's reads, and change-feed's boot check holds each table to its
 * opt-out (`ExcludeFromChangeFeed`).
 */
export function offFeedReach<P extends ResourceParams>(
  reach: ReachPlan<P>,
  reason: string,
): ReachPlan<P> {
  if ((reach.relations ?? []).length > 0) {
    throw new Error(
      `offFeedReach: the plan reads relations (${reach.relations!.map((r) => `"${r.relation}"`).join(", ")}) — a view or rollup is reached through its bases' change feed, never served off it.`,
    );
  }
  return offFeedTablesReach<P>(
    [
      ...reach.routes.map((r) => r.table),
      ...(reach.unfed ?? []).map((u) => u.table),
    ],
    reason,
  );
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
