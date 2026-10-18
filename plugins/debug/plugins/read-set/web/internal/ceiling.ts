import type { ResourceDebug, ResourcePolicy } from "../../core";

// The read-set ceiling (A7): what a change costs each entry, read off the
// runtime's own fields — `policy` (what the entry is), `routes` /
// `relationReads` (what
// its plan declares, a routed entry's or an external one's) and `routeDrifted`
// (what its drift guard caught) — never re-derived here from read-sets, so the
// pane cannot disagree with the router about who a write reaches, or how.

/**
 * One `full` route of an entry's plan — a routed entry's, or an external
 * one's declared reads: a declared FULL, with its reason.
 */
export interface RoutedFullEntry {
  key: string;
  /** `routed`, or the `external` entry whose declared reads reach it beside its notify. */
  policy: ResourcePolicy;
  /** The route's id. */
  route: string;
  /** The table it is reached through. */
  table: string;
  reason: string;
}

/** A view (or rollup) an entry's plan reads whole, reached through its bases. */
export interface RelationReadEntry {
  key: string;
  policy: ResourcePolicy;
  relation: string;
  /** Its relation bases, sorted: a write to any recomputes the entry FULL. */
  bases: string[];
  reason: string;
}

/** An entry's drift (A8 routed, D5 external): captured tables its plan does not cover (raw-table space). */
export interface DriftEntry {
  key: string;
  policy: ResourcePolicy;
  tables: string[];
}

export interface Ceiling {
  routedFull: RoutedFullEntry[];
  relationReads: RelationReadEntry[];
  drift: DriftEntry[];
  /**
   * External entries no change to Postgres reaches: no declared route or
   * relation read, no drift — only their own `notify()`.
   */
  pureExternal: string[];
  /** Every entry's key, by policy — each key under exactly one. */
  keys: Record<ResourcePolicy, string[]>;
}

const byKey = (a: { key: string }, b: { key: string }): number =>
  a.key.localeCompare(b.key);

/**
 * Classify every `_debug` entry:
 *
 * - `routedFull` — each `full` route of any entry's plan, with its reason —
 *   a routed entry's, or an external one's declared reads (D1).
 * - `relationReads` — each view / rollup a plan reads whole, with its bases.
 * - `drift` — any entry's non-empty `routeDrifted`, as the runtime's guard
 *   recorded it (A8 routed, D5 external; raw-table space — NOT recomputed from
 *   the bases, which would flag a view's rollup sources that the plan reaches
 *   as derived reads).
 * - `pureExternal` — external entries no table change reaches (see `Ceiling`).
 * - `keys` — every key under its policy.
 */
export function computeCeiling(resources: readonly ResourceDebug[]): Ceiling {
  const routedFull: RoutedFullEntry[] = [];
  const relationReads: RelationReadEntry[] = [];
  const drift: DriftEntry[] = [];
  const pureExternal: string[] = [];
  const keys: Record<ResourcePolicy, string[]> = {
    routed: [],
    external: [],
    unrouted: [],
    unbound: [],
  };

  for (const r of resources) {
    keys[r.policy].push(r.key);
    if (
      r.policy === "external" &&
      !r.routes?.length &&
      r.relationReads.length === 0 &&
      r.routeDrifted.length === 0
    ) {
      pureExternal.push(r.key);
    }
    // Whatever the policy: an external entry's declared reads are routes too.
    for (const route of r.routes ?? []) {
      if (route.map !== "full") continue;
      routedFull.push({
        key: r.key,
        policy: r.policy,
        route: route.id,
        table: route.table,
        reason: route.reason,
      });
    }
    for (const read of r.relationReads) {
      relationReads.push({
        key: r.key,
        policy: r.policy,
        relation: read.relation,
        bases: [...read.bases].sort(),
        reason: read.reason,
      });
    }
    if (r.routeDrifted.length > 0) {
      drift.push({
        key: r.key,
        policy: r.policy,
        tables: [...r.routeDrifted].sort(),
      });
    }
  }

  routedFull.sort(
    (a, b) =>
      byKey(a, b) ||
      a.table.localeCompare(b.table) ||
      a.route.localeCompare(b.route),
  );
  relationReads.sort(
    (a, b) => byKey(a, b) || a.relation.localeCompare(b.relation),
  );
  drift.sort(byKey);
  pureExternal.sort();
  for (const list of Object.values(keys)) list.sort();
  return { routedFull, relationReads, drift, pureExternal, keys };
}
