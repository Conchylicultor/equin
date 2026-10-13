import type { ResourceDebug, ResourcePolicy } from "../../core";

// The read-set ceiling (A7): what a change costs each entry, read off the
// runtime's own fields — `policy` (what the entry is) and `legacyReach` (the
// bases its legacy router indexes it under) — never re-derived here from routes
// or read-sets, so the pane cannot disagree with the router about who a write
// reaches, or how.

/**
 * An entry the legacy router reaches: a write to ANY of its bases recomputes
 * it FULL. Every `legacy-full` entry, plus every external or unbound entry
 * whose captured read-set gives it a non-empty `legacyReach`.
 */
export interface LegacyFullEntry {
  key: string;
  /** `legacy-full`, or the `external` / `unbound` entry the router reaches beside its own notify. */
  policy: ResourcePolicy;
  /** Its `legacyReach`, sorted (base-table space); `[]` = no loader run captured yet. */
  bases: string[];
  /** Subscribed params-tuples. */
  tuples: number;
  persisted: boolean;
  /** Age of the persisted row's position (ms); `null` when unknown or not persisted. */
  positionAgeMs: number | null;
  /**
   * FULL loads one base write costs: one per subscribed tuple, or — with none
   * subscribed — the `{}` tuple a persisted entry keeps current (an
   * unpersisted entry with no subscriber loads nothing).
   */
  loadsPerWrite: number;
}

/** One `full` route of a routed entry: a declared FULL, with its reason. */
export interface RoutedFullEntry {
  key: string;
  /** The route's id. */
  route: string;
  /** The table it is reached through. */
  table: string;
  reason: string;
}

/** A routed entry's A8 drift: captured tables no route names (raw-table space). */
export interface DriftEntry {
  key: string;
  tables: string[];
}

export interface Ceiling {
  legacyFull: LegacyFullEntry[];
  routedFull: RoutedFullEntry[];
  drift: DriftEntry[];
  /** External entries the legacy router does NOT reach: only their own `notify()` does. */
  pureExternal: string[];
  /** Every entry's key, by policy — each key under exactly one. */
  keys: Record<ResourcePolicy, string[]>;
}

const byKey = (a: { key: string }, b: { key: string }): number =>
  a.key.localeCompare(b.key);

/**
 * Classify every `_debug` entry:
 *
 * - `legacyFull` — every entry with `policy === "legacy-full"` (listed even
 *   before its loader ran, with no bases) or a non-empty `legacyReach` (an
 *   external entry whose loader read the DB — `automations.catalog`,
 *   `edited-files` — is recomputed FULL by its bases, beside its own notify).
 *   Bases are transitive, rollups expanded: `edited-files` lists `attempts,
 *   conversations, tasks`, not the `conversations_v` it read.
 * - `routedFull` — each `full` route of a routed entry, with its reason.
 * - `drift` — a routed entry's non-empty `routeDrifted`, as the runtime's guard
 *   recorded it (raw-table space — NOT recomputed from the bases, which would
 *   flag a view's rollup sources that the plan reaches as derived reads).
 * - `pureExternal` — external entries with no legacy reach.
 * - `keys` — every key under its policy.
 */
export function computeCeiling(resources: readonly ResourceDebug[]): Ceiling {
  const legacyFull: LegacyFullEntry[] = [];
  const routedFull: RoutedFullEntry[] = [];
  const drift: DriftEntry[] = [];
  const pureExternal: string[] = [];
  const keys: Record<ResourcePolicy, string[]> = {
    routed: [],
    "legacy-full": [],
    external: [],
    unbound: [],
  };

  for (const r of resources) {
    keys[r.policy].push(r.key);
    if (r.policy === "legacy-full" || r.legacyReach.length > 0) {
      legacyFull.push({
        key: r.key,
        policy: r.policy,
        bases: [...r.legacyReach].sort(),
        tuples: r.tuples,
        persisted: r.persisted,
        positionAgeMs: r.positionAgeMs,
        loadsPerWrite: Math.max(r.tuples, r.persisted ? 1 : 0),
      });
    } else if (r.policy === "external") {
      pureExternal.push(r.key);
    }
    if (r.policy === "routed") {
      for (const route of r.routes ?? []) {
        if (route.map !== "full") continue;
        routedFull.push({
          key: r.key,
          route: route.id,
          table: route.table,
          reason: route.reason,
        });
      }
      if (r.routeDrifted.length > 0) {
        drift.push({ key: r.key, tables: [...r.routeDrifted].sort() });
      }
    }
  }

  legacyFull.sort(byKey);
  routedFull.sort(
    (a, b) =>
      byKey(a, b) ||
      a.table.localeCompare(b.table) ||
      a.route.localeCompare(b.route),
  );
  drift.sort(byKey);
  pureExternal.sort();
  for (const list of Object.values(keys)) list.sort();
  return { legacyFull, routedFull, drift, pureExternal, keys };
}
