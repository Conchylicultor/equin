// Scoped change routing: the SQL-free contract between whatever produces a table
// change (the Postgres feed today, in-process producers later) and a resource
// whose compiler declared, as data, how that table's changed rows map to its own
// host ids and which of its tuples read the table at all. The runtime's
// `routeTableChange` consumes it; this module holds the types and the one pure
// per-tuple decision, so it names no contributor and touches no registry.
//
// See research/2026-09-29-global-scoped-change-routing.md (§Runtime contract,
// §Algorithm). Every DB-backed entry declares routes or a reach plan — one
// with neither is reached by no change, and change-feed refuses it at boot.

/**
 * Where a change came from. `feed` — the Postgres change feed (a trigger's
 * NOTIFY, a catch-up replay of its changelog, a reconnect sweep). `producer` —
 * an in-process change producer (change-feed's `defineChangeProducer`), the
 * change source of a table the feed installs no trigger on. Attribution only:
 * the cascade is identical, but the notify counters and the read-set-gap match
 * are kept per source, and only a feed change carries a transaction to ack.
 */
export type ChangeSource = "feed" | "producer";

/** What every producer hands the router. `table` is always a BASE table. */
export interface TableChange {
  /** Required: every producer states which one it is (see `ChangeSource`). */
  source: ChangeSource;
  table: string;
  op: "I" | "U" | "D";
  /**
   * The changed rows' single-column PK values as text. `null` = the rows are
   * unknown (bulk / over-cap / sweep / composite key without `keys`). An empty
   * array is a KNOWN empty set: the statement changed no row, so no route is
   * touched.
   */
  ids: readonly string[] | null;
  /**
   * The table's emitted key layout — columnar and row-aligned (every column
   * array has one entry per changed row). For a `U`, the rows are DISTINCT over
   * old ∪ new, so a moved foreign key names both of its hosts. `null` = unknown.
   */
  keys: Readonly<Record<string, readonly (string | null)[]>> | null;
  /**
   * `U` only: columns whose value is KNOWN equal in every row the statement
   * touched (old and new paired by the PK). A fact about the rows, true
   * whatever columns the producer compared — a column it did not compare is
   * simply not listed — so it stays sound across a change of routes (a
   * catch-up replay) and needs no agreement with the reader on a gate. A
   * route whose every column is listed skips the change; a use whose every
   * `moves` column is listed reads it in the value role. `null` = unknown
   * (not a `U`, an ungated table, or a key that moved — old and new cannot be
   * paired); `[]` = paired, and every compared column differed. Required: one
   * spelling of "unknown", which a producer states.
   */
  unchanged: readonly string[] | null;
  /** Source transaction (xid8 text) — the mutation-ack attribution (`ackTx`). */
  xid?: string;
  /** Wall-clock epoch ms of the change (see `PendingNotify.changedAt`). */
  changedAt?: number;
}

/** How one table's changed rows map into the host's `keyOf` space. */
export type HostMap =
  /**
   * The table's rows ARE host rows (the base table; a union arm with `encode`).
   * `column` absent = the table's single-column PK, read from `change.ids`.
   * A `D` means the host row is gone.
   */
  | {
      kind: "identity";
      column?: string;
      encode?: (value: string) => string;
    }
  /**
   * The changed row carries its host key in `column` (an extension's
   * `parent_id`, a custom value's `row_key`). Whatever the op, the host row may
   * have changed — a side-table I / U / D is a host U, never a host I / D.
   * `column` absent = the table's single-column PK carries the host key (an
   * extension, keyed by its host's id), read from `change.ids` like an
   * `identity` route's.
   */
  | {
      kind: "alias";
      column?: string;
      encode?: (value: string) => string;
    }
  /**
   * The HOST side references the changed row (an N:1 lookup). The changed
   * `column` values are resolved to host ids in the drain, batched once per
   * (entry, route, flush); `within` bounds the answer to ids the reading tuples
   * can hold (null = unbounded), and more than `cap` hosts answers `"over-cap"`.
   * `column` absent = the lookup is on the changed table's single-column PK,
   * read from `change.ids` (no carried key — so a statement too large to list
   * its keys still names its rows, and `ids: null` is FULL like any unknown).
   */
  | {
      kind: "reverse";
      column?: string;
      resolve: (
        changed: readonly string[],
        within: ReadonlySet<string> | null,
        cap: number,
      ) => Promise<readonly string[] | "over-cap">;
    }
  /** Unmappable: every tuple reading this table recomputes FULL, for `reason`. */
  | { kind: "full"; reason: string };

/** One table occurrence a compiled query may read, and how its changes map to host ids. */
export interface Route {
  /** Unique within the resource. `usesOf` names the occurrences a tuple reads by it. */
  id: string;
  table: string;
  map: HostMap;
  /**
   * The columns of `table` the compiled SQL references (join keys, projected,
   * where / order), emitted by the compiler only. A `U` that left all of them
   * `unchanged` routes nowhere.
   */
  columns: readonly string[];
  /** Static row filter on the emitted keys, e.g. `{ data_view_id: "<surface>" }`. */
  rows?: Readonly<Record<string, string>>;
  /**
   * The key columns a tuple's `TupleUse.match` may filter this route's rows
   * on (e.g. `["column_id"]`), declared so the change feed carries them in
   * `keys`. A use matching on an undeclared column is refused (the tuple
   * recomputes FULL, reported).
   */
  match?: readonly string[];
}

/**
 * What one BASE table's change-feed trigger must emit for the routes reading
 * it (`tableLayoutRequirements`): the key layout it carries, and the column
 * sets its routes read — what the trigger resolves its `unchanged` comparison
 * from.
 */
export interface TableLayoutRequirement {
  table: string;
  /**
   * Columns carried in `TableChange.keys`, row-aligned and DISTINCT over the
   * rows the statement touched (`old ∪ new` for an UPDATE, `old` for a DELETE):
   * every map's `column`, and every `rows` / `match` key.
   */
  carry: readonly string[];
  /**
   * Each route's `columns`, DISTINCT (each sorted, the list sorted). The
   * trigger compares only the columns of the sets that miss some column of
   * the table (`resolveLayout`): only such a route can be skipped by an
   * `unchanged` set, so comparing a column that only a whole-table route
   * reads is wasted work on every UPDATE (a `body_html` detoasted and
   * compared to skip nothing). Soundness never depends on this choice — a
   * column left uncompared is just not reported unchanged.
   */
  reads: readonly (readonly string[])[];
}

/**
 * The trigger layout every route on each table needs — derived from the
 * routes, never declared beside them. Pure; tables and columns sorted, so the
 * layout (and the trigger DDL rendered from it) is stable across boots.
 */
export function tableLayoutRequirements(
  routes: Iterable<Route>,
): TableLayoutRequirement[] {
  const byTable = new Map<
    string,
    { carry: Set<string>; reads: Map<string, readonly string[]> }
  >();
  for (const route of routes) {
    let req = byTable.get(route.table);
    if (!req) {
      req = { carry: new Set(), reads: new Map() };
      byTable.set(route.table, req);
    }
    const map = route.map;
    if (map.kind !== "full" && map.column !== undefined) {
      req.carry.add(map.column);
    }
    for (const column of Object.keys(route.rows ?? {})) req.carry.add(column);
    for (const column of route.match ?? []) req.carry.add(column);
    const read = [...new Set(route.columns)].sort();
    req.reads.set(JSON.stringify(read), read);
  }
  return [...byTable]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([table, { carry, reads }]) => ({
      table,
      carry: [...carry].sort(),
      reads: [...reads]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, read]) => read),
    }));
}

/** How one tuple reads one route occurrence. */
export interface TupleUse {
  /**
   * `membership` — the occurrence can move the tuple's membership or order (an
   * INNER join, or a where / order field reading it). `value` — it is only
   * projected, so a change can only rewrite rows the tuple already holds.
   */
  role: "membership" | "value";
  /** Per-tuple row filter on the emitted keys, e.g. `{ column_id: {c1} }`. */
  match?: Readonly<Record<string, ReadonlySet<string>>>;
  /**
   * A `membership` use only: the columns of the route's table whose change can
   * move THIS tuple's membership or order — the columns its `where` / order
   * read, and the join conditions of the joins it reads as membership.
   * Compiler-emitted, a subset of the route's `columns`. A `U` whose
   * `unchanged` set lists all of them cannot move the tuple, so it is
   * delivered in the `value` role (a host the tuple does not hold loads
   * nothing; a reverse route resolves within the tuple's members). Absent =
   * every column (an identity `I` / `D` is always membership).
   */
  moves?: readonly string[];
}

// The mark `mintRoutePlan` / `mintReachPlan` put on a plan. Module-private, so a
// plan cannot be spelled as an object literal anywhere else: `tsc` rejects the
// missing key, and the runtime refuses an unmarked plan an `as` cast let through.
const MINTED: unique symbol = Symbol("route-plan.minted");

/**
 * A DERIVED relation a compiled SQL reads that no route names: a
 * trigger-maintained rollup (derived-tables), which has no change-feed trigger
 * of its own (A1: no route names a rollup). Its rows move only when one of its
 * `sources` is written, and every source is a route table of the same plan
 * (A22, asserted by `mintRoutePlan`) — so a read of `table` is reached through
 * those routes, and the drift guard (A8) accepts it in a loader's capture.
 */
export interface DerivedRead {
  /** The derived table's name, as a captured read-set records it. */
  table: string;
  /** The base tables whose writes move it — each one a route table of the plan. */
  sources: readonly string[];
}

/** The fields of a plan, before it is minted (see `mintRoutePlan`). */
export interface RoutePlanInput<
  P extends Record<string, string> = Record<string, string>,
> {
  routes: readonly Route[];
  usesOf(params: P): ReadonlyMap<string, TupleUse>;
  /**
   * The derived relations (rollups) the compiled SQL reads beside its route
   * tables — see `DerivedRead`. Absent = none: the plan reads only its route
   * tables (every compile but one joining a rollup).
   */
  derivedReads?: readonly DerivedRead[];
  /**
   * A deterministic fingerprint of the compiled SQL and its decoding — the
   * L2 definition (A18). A persisted row written under another definition is
   * not usable: every L2 read matches `definition IS NOT DISTINCT FROM` the
   * running entry's (`persistedDefinitions()`), so a code change that moves
   * the SQL never serves a value computed by the old one. Absent = the entry
   * persists with a NULL definition (a hand-declared resource, or a compiler
   * that does not fingerprint yet).
   */
  definition?: string;
}

/**
 * A routed resource's plan: every table occurrence its SQL may read, and a pure
 * per-tuple read-set. `usesOf` must be pure, synchronous and total — the runtime
 * memoizes it per tuple. A route id absent from its answer is an occurrence that
 * tuple never reads.
 *
 * MINTED, never written: only `mintRoutePlan` makes one, and only a query
 * compiler calls it (the `resource-runtime:compiled-routes` check). A route's
 * `columns` gate which updates reach the resource, so a hand-kept list that
 * missed a column the SQL reads would silently drop that column's updates.
 */
export interface RoutePlan<
  P extends Record<string, string> = Record<string, string>,
> extends RoutePlanInput<P> {
  readonly [MINTED]: true;
}

/** A route whose changed rows map to no host id: every tuple reading it recomputes FULL. */
export type FullRoute = Route & {
  map: Extract<HostMap, { kind: "full" }>;
};

/**
 * A relation (a view, or a trigger-maintained rollup) a non-keyed entry's
 * loader reads WHOLE, named as the loader's SQL names it (a served value's
 * `reads.tables` naming a view). No route names it — a change names only base
 * tables, and a view has no trigger — so the runtime expands it to its relation
 * bases (`ResourceRuntimeOptions.relationBases`) once they are known
 * (`ResourceRuntime.indexRelationReads`), and a write to any base recomputes
 * every target FULL. The drift guard (A8) accepts the relation's own name in a
 * capture, which records relations as the SQL read them.
 */
export interface RelationRead {
  /** The relation's name, as a captured read-set records it. */
  relation: string;
  /** Why the value reads it whole — shown with its bases in `_debug`. */
  reason: string;
}

/**
 * A table a non-keyed entry's loader reads that has NO change source by
 * declaration — opted out of the feed (`ExcludeFromChangeFeed`): a bulk cache
 * the value reads through a memo keyed on something it does route (a served
 * value's `reads.outsideFeed`). No route names it (a route on an untriggered
 * table is refused at boot, A1′); the drift guard (A8) accepts it in a capture,
 * and change-feed's boot check refuses one that DOES have a change source — a
 * table the feed reports would be a missed write, not a declared one.
 */
export interface UnfedRead {
  /** The table's name, as a captured read-set records it. */
  table: string;
  /** Why the value may read it without being told of its writes. */
  reason: string;
}

/** The fields of a `ReachPlan`, before it is minted (see `mintReachPlan`). */
export interface ReachPlanInput<
  P extends Record<string, string> = Record<string, string>,
> extends RoutePlanInput<P> {
  routes: readonly FullRoute[];
  /**
   * No L2 fingerprint: a hand-written loader (a served value) has no compiled
   * SQL to fingerprint, and a `:groups` aggregate is never persisted. A
   * persisted reach value (`notifications.unread`, `icons.saved-sprites`) keeps
   * rows with a NULL definition, which the L2 usable-row predicate matches
   * against the NULL it expects (NULL matches NULL).
   */
  definition?: never;
  /**
   * A grouping joins no rollup (C9 / D24 of
   * research/2026-10-06-global-scoped-change-routing-p8-v3.md): its routes are
   * one `full` route per relation it reads, which a rollup — routed through
   * its sources — cannot be.
   */
  derivedReads?: never;
  /** Tables read outside the change feed by declaration — see `UnfedRead`. */
  unfed?: readonly UnfedRead[];
  /** Views / rollups read whole, reached through their bases — see `RelationRead`. */
  relations?: readonly RelationRead[];
}

/**
 * A NON-keyed entry's plan (a collection's `:groups` aggregate): which tuples
 * read which tables, and nothing more. Its routes may only be `full` — a push
 * value has no host ids to refill, so a relevant change recomputes the tuple
 * and an irrelevant one reaches nothing. (`TupleUse.role` / `match` are read
 * the same way; the role is moot when every route is `full`.) Minted like a
 * `RoutePlan`, by `mintReachPlan`.
 */
export interface ReachPlan<
  P extends Record<string, string> = Record<string, string>,
> extends RoutePlan<P> {
  routes: readonly FullRoute[];
  definition?: never;
  derivedReads?: never;
  unfed?: readonly UnfedRead[];
  relations?: readonly RelationRead[];
}

/**
 * A plan's derived reads must be reached through its routes, and never be
 * routed themselves — checked when the plan is minted, i.e. at the compile's
 * module eval:
 *
 * - A1: a derived table is not a route table (a rollup has no change-feed
 *   trigger; a route on it would wait for a change that never arrives);
 * - A22: every source of a derived table is a route table of THIS plan, so a
 *   write that moves the derived rows reaches the entry (the drift guard then
 *   accepts the derived table in a loader's capture — A8);
 * - one entry per derived table, and at least one source each.
 */
function assertDerivedReads(
  routes: readonly Route[],
  derivedReads: readonly DerivedRead[],
): void {
  const routed = new Set(routes.map((r) => r.table));
  const seen = new Set<string>();
  for (const d of derivedReads) {
    if (seen.has(d.table)) {
      throw new Error(
        `mintRoutePlan: derived read "${d.table}" is listed twice — one entry per derived table.`,
      );
    }
    seen.add(d.table);
    if (routed.has(d.table)) {
      throw new Error(
        `mintRoutePlan: "${d.table}" is both a derived read and a route table — a derived table (a rollup) has no change-feed trigger, so no route may name it (A1); it is reached through its sources' routes.`,
      );
    }
    if (d.sources.length === 0) {
      throw new Error(
        `mintRoutePlan: derived read "${d.table}" names no source — nothing would route a change to it.`,
      );
    }
    const unrouted = d.sources.filter((s) => !routed.has(s));
    if (unrouted.length > 0) {
      throw new Error(
        `mintRoutePlan: derived read "${d.table}" is moved by ${unrouted.map((s) => `"${s}"`).join(", ")}, which no route of the plan names — a write there would change what the SQL reads without reaching the entry (A22). Its compiler must route every source.`,
      );
    }
  }
}

/**
 * Mint a compiler's route plan — the only way to make a `RoutePlan`. Called by
 * the query compilers (`infra/query-resource`), which emit every route from the
 * same declaration they render the SQL from, and by tests; the
 * `resource-runtime:compiled-routes` check refuses any other caller. Throws on
 * `derivedReads` that a route names (A1) or whose sources it does not (A22).
 */
export function mintRoutePlan<P extends Record<string, string>>(
  plan: RoutePlanInput<P>,
): RoutePlan<P> {
  const derivedReads = plan.derivedReads ?? [];
  assertDerivedReads(plan.routes, derivedReads);
  return {
    routes: plan.routes,
    usesOf: plan.usesOf,
    ...(plan.definition !== undefined ? { definition: plan.definition } : {}),
    // Only when non-empty: a plan reading no derived table is the shape it
    // always was.
    ...(derivedReads.length > 0 ? { derivedReads } : {}),
    [MINTED]: true,
  };
}

/**
 * Mint a non-keyed entry's reach plan (see `mintRoutePlan`). Throws on an
 * `unfed` table a route names (it is either routed or read outside the feed),
 * listed twice, or with no reason — and on a relation read that is also a
 * route or unfed table, listed twice, or with no reason.
 */
export function mintReachPlan<P extends Record<string, string>>(
  plan: ReachPlanInput<P>,
): ReachPlan<P> {
  const unfed = plan.unfed ?? [];
  const routed = new Set(plan.routes.map((r) => r.table));
  const seen = new Set<string>();
  for (const u of unfed) {
    if (routed.has(u.table) || seen.has(u.table)) {
      throw new Error(
        `mintReachPlan: "${u.table}" is ${routed.has(u.table) ? "both routed and read outside the feed" : "listed twice as read outside the feed"} — a table is one or the other, once.`,
      );
    }
    if (u.reason.trim() === "") {
      throw new Error(
        `mintReachPlan: "${u.table}" is read outside the feed with no reason.`,
      );
    }
    seen.add(u.table);
  }
  const relations = plan.relations ?? [];
  const relationSeen = new Set<string>();
  for (const r of relations) {
    if (routed.has(r.relation) || seen.has(r.relation)) {
      throw new Error(
        `mintReachPlan: "${r.relation}" is both a relation read and ${routed.has(r.relation) ? "a route table" : "read outside the feed"} — a relation read is a view or rollup reached through its bases, never a routed or unfed table.`,
      );
    }
    if (relationSeen.has(r.relation)) {
      throw new Error(
        `mintReachPlan: relation "${r.relation}" is listed twice — one entry per relation.`,
      );
    }
    if (r.reason.trim() === "") {
      throw new Error(
        `mintReachPlan: relation "${r.relation}" is read with no reason.`,
      );
    }
    relationSeen.add(r.relation);
  }
  return {
    routes: plan.routes,
    usesOf: plan.usesOf,
    ...(unfed.length > 0 ? { unfed } : {}),
    // Only when non-empty, like `unfed`: a plan reading no relation is the
    // shape it always was.
    ...(relations.length > 0 ? { relations } : {}),
    [MINTED]: true,
  };
}

/** Whether `plan` came from `mintRoutePlan` / `mintReachPlan` (not a cast literal). */
export function isMintedPlan(plan: RoutePlanInput<never>): boolean {
  return (plan as Partial<RoutePlan>)[MINTED] === true;
}

/** A `reverse` route, narrowed. */
export type ReverseRoute = Route & {
  map: Extract<HostMap, { kind: "reverse" }>;
};

/** A reverse route this tuple reads, with the changed values the drain must resolve. */
export interface UnresolvedReverse {
  route: ReverseRoute;
  changed: readonly string[];
  role: TupleUse["role"];
}

/**
 * The outcome of one change for one tuple, before the runtime shapes it by the
 * tuple's membership kind:
 *
 * - `untouched` — no route this tuple reads saw a relevant row (the tuple is
 *   skipped; it may still owe the writer an ack);
 * - `full` — an unmappable route, unknown values, or a throwing `encode`;
 * - `scoped` — `affected` are host ids whose membership may have moved,
 *   `valueOnly` host ids reached only in the value role — a value-role route,
 *   or a `U` that missed its membership use's `moves` (the runtime may drop the
 *   non-members among them) — `deleted` identity-`D` host ids, and
 *   `unresolved` the reverse routes the drain resolves.
 */
export type TupleRouting =
  | { kind: "untouched" }
  | { kind: "full" }
  | {
      kind: "scoped";
      affected: Set<string>;
      valueOnly: Set<string>;
      deleted: Set<string>;
      unresolved: UnresolvedReverse[];
    };

// The row indices of `change.keys` that pass every filter, or `"unknown"` when
// the keys are absent or the layout lacks a filtered column (the rows cannot be
// told apart, so none may be dropped).
function selectRows(
  keys: TableChange["keys"],
  filters: ReadonlyArray<readonly [string, ReadonlySet<string>]>,
): number[] | "unknown" {
  if (keys === null) return "unknown";
  const columns = Object.values(keys);
  if (columns.length === 0) return "unknown";
  const rowCount = columns[0]!.length;
  const filterColumns: Array<
    readonly [readonly (string | null)[], ReadonlySet<string>]
  > = [];
  for (const [column, allowed] of filters) {
    const values = keys[column];
    if (values === undefined) return "unknown";
    filterColumns.push([values, allowed]);
  }
  const rows: number[] = [];
  for (let i = 0; i < rowCount; i++) {
    let pass = true;
    for (const [values, allowed] of filterColumns) {
      const v = values[i];
      if (v === null || v === undefined || !allowed.has(v)) {
        pass = false;
        break;
      }
    }
    if (pass) rows.push(i);
  }
  return rows;
}

// The changed values a map reads, or `null` when they are unknown. A map with no
// `column` reads the PK straight off `change.ids` — the row filter cannot narrow
// those (ids are not row-aligned with `keys`), so it over-approximates to every
// changed row: one extra refill, never a missed one.
function valuesOf(
  change: TableChange,
  rows: number[] | "unknown",
  column: string | undefined,
): string[] | null {
  if (column === undefined) return change.ids === null ? null : [...change.ids];
  if (rows === "unknown") return null;
  const values = change.keys?.[column];
  if (values === undefined) return null;
  const out = new Set<string>();
  for (const i of rows) {
    const v = values[i];
    if (v !== null && v !== undefined) out.add(v);
  }
  return [...out];
}

/**
 * Route one change for one tuple: walk the routes on `change.table` this tuple
 * reads (per `uses`) through the gate, the key filter and the map. Pure. A
 * throwing `encode` propagates — the runtime reports it and FULLs the tuple.
 */
export function routeTuple(
  change: TableChange,
  routes: readonly Route[],
  uses: ReadonlyMap<string, TupleUse>,
): TupleRouting {
  const affected = new Set<string>();
  const valueCandidates = new Set<string>();
  const deleted = new Set<string>();
  const unresolved: UnresolvedReverse[] = [];
  // Whether a U is known to have left every one of `columns` as it was.
  const known = change.op === "U" ? change.unchanged : null;
  const allUnchanged = (columns: readonly string[]): boolean =>
    known !== null && columns.every((c) => known.includes(c));
  let touched = false;
  for (const route of routes) {
    const use = uses.get(route.id);
    if (use === undefined) continue; // this tuple never reads this occurrence
    // 1. Gate: a U that left every column the SQL references unchanged.
    if (allUnchanged(route.columns)) continue;
    // 2. Key filter: the route's static rows ∧ this tuple's match.
    const filters: Array<readonly [string, ReadonlySet<string>]> = [];
    for (const [column, value] of Object.entries(route.rows ?? {})) {
      filters.push([column, new Set([value])]);
    }
    for (const [column, allowed] of Object.entries(use.match ?? {})) {
      filters.push([column, allowed]);
    }
    const rows = selectRows(change.keys, filters);
    if (rows !== "unknown" && rows.length === 0) continue;
    if (rows === "unknown" && change.ids !== null && change.ids.length === 0) {
      continue; // a known-empty statement touches nothing
    }
    // 3. Unmappable, or values unknown ⇒ this tuple recomputes FULL.
    if (route.map.kind === "full") return { kind: "full" };
    const values = valuesOf(change, rows, route.map.column);
    if (values === null) return { kind: "full" };
    if (values.length === 0) continue;
    touched = true;
    // A U that left every column that can move this tuple unchanged is a
    // value change for it, whatever its declared role.
    const role: TupleUse["role"] =
      use.role === "membership" &&
      use.moves !== undefined &&
      allUnchanged(use.moves)
        ? "value"
        : use.role;
    // 4. Map by kind.
    switch (route.map.kind) {
      case "identity": {
        const encode = route.map.encode;
        const target =
          change.op === "D"
            ? deleted
            : role === "value"
              ? valueCandidates
              : affected;
        for (const v of values) target.add(encode ? encode(v) : v);
        break;
      }
      case "alias": {
        // Whatever the op, a host U: the host row still exists and may have changed.
        const encode = route.map.encode;
        const target = role === "value" ? valueCandidates : affected;
        for (const v of values) target.add(encode ? encode(v) : v);
        break;
      }
      case "reverse":
        unresolved.push({
          route: route as ReverseRoute,
          changed: values,
          role,
        });
        break;
    }
  }
  if (!touched) return { kind: "untouched" };
  // A host reached through any membership-role route is membership, whatever
  // else reached it.
  const valueOnly = new Set<string>();
  for (const id of valueCandidates) if (!affected.has(id)) valueOnly.add(id);
  return { kind: "scoped", affected, valueOnly, deleted, unresolved };
}
