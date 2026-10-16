// Boot-time invariant (A1′): every table a routed live-state resource's routes
// name has a change source — a table the change-feed ACTUALLY installs a
// trigger on, or one a mounted in-process change producer feeds (./producer).
//
// A ROUTED resource (`routes` / `reach`, compiler-emitted) is reached ONLY
// through its routes, so every route's table must fire, whatever its map. The
// change can only come from a table the change-feed put a trigger
// on (see ./triggers `coveredTables`) or whose producer emits it — the caller
// passes the union as `coveredTables`.
//
// WHY this is a bug, not a warning. If the named table has NO trigger — because
// it was excluded (ExcludeFromChangeFeed), is a feed-exempt derived-table rollup,
// is a VIEW name instead of its base table (the documented footgun in
// resource-runtime; a routed compiler also refuses a view `from` itself), or is a
// typo / dropped table — it never fires pg_notify, never appends a changelog row,
// never drives a recompute. So the declared delivery can never happen: the
// resource silently degrades to hydrate-on-mount while its declaration positively
// claims live scoping. Nothing else in the system reveals the mismatch — the
// read-set ceiling pane shows the resource as fully covered, because coverage is
// computed from the declaration, not from whether a trigger actually exists.
//
// The single authoritative question is "is the table in the set of tables we
// installed triggers on, or a produced one?" — which subsumes the ExcludeFromChangeFeed case AND
// catches the typo / view / rollup / nonexistent variants of the exact same
// dead-scope failure mode. We still classify each violation by WHY it is
// uncovered, because the remediations differ (an excluded table can have its
// exclusion dropped; a rollup must be keyed off its source; a typo/view is just a
// wrong string).
//
// This is the sibling of `warnOnCoverageGaps` (triggers.ts): both reconcile the
// change-feed against its consumers at boot because a static `./singularity check`
// can reach neither a live DB nor the server-only contribution/registry sets. This
// one THROWS (blocks boot) rather than warning, because a routed resource on an
// untriggered table is always a definite bug with a clear fix, never transient
// drift — the covered-tables set is exactly what `rebuildTriggers` just installed,
// so any real base table a resource legitimately reads is present by
// construction, and a miss is never a false positive.

/** One table a routed resource's routes name (server-core's `scopedResourceTables`). */
export interface ScopedResourceTable {
  /** The resource key (for the diagnostic). */
  key: string;
  /** The base table the resource depends on. */
  table: string;
  /** The route that names it: `route "<id>"`. */
  via: `route "${string}"`;
}

// Why a table is not in the triggered set — drives the per-violation
// remediation. Ordered from most-specific (a deliberate opt-out) to least (a
// wrong string).
export type RouteCoverageReason =
  // Table opted out of the feed via `ExcludeFromChangeFeed`.
  | "excluded"
  // Table is a derived-table rollup — feed-exempt by design (a read-cache of its
  // source, never independently triggered).
  | "rollup"
  // No trigger for any known reason: a typo, a VIEW name (it must be the BASE
  // table), or a dropped / nonexistent table.
  | "uncovered";

export interface RouteCoverageViolation extends ScopedResourceTable {
  reason: RouteCoverageReason;
}

/**
 * Classify why a table is not triggered. Only called for tables already known
 * to be absent from `coveredTables`.
 */
function classify(
  table: string,
  excludedTables: ReadonlySet<string>,
  exemptTables: ReadonlySet<string>,
): RouteCoverageReason {
  if (excludedTables.has(table)) return "excluded";
  if (exemptTables.has(table)) return "rollup";
  return "uncovered";
}

/**
 * The resource tables NOT in the set of tables with a change source (the
 * triggered ∪ produced set) — i.e. those whose declared delivery can never
 * fire. Pure; the boot install feeds it `scopedResourceTables()`,
 * `getCoveredTables()` ∪ `producedTableNames()`, `excludedTableNames()`, and
 * `feedExemptTables()`. The exclusion / exempt sets
 * are used only to classify the reason (for remediation), never to decide
 * membership — coverage is the single source of truth.
 */
export function findUncoveredRouteTables(
  scoped: readonly ScopedResourceTable[],
  coveredTables: ReadonlySet<string>,
  excludedTables: ReadonlySet<string>,
  exemptTables: ReadonlySet<string>,
): RouteCoverageViolation[] {
  return scoped
    .filter((r) => !coveredTables.has(r.table))
    .map((r) => ({
      ...r,
      reason: classify(r.table, excludedTables, exemptTables),
    }));
}

// The remediation copy for each reason. Every case shares the universal fallback:
// give the table a change source (a change producer), or make the resource a
// plain push resource with no scope (hydrate-on-mount, like Studio's sample-rows).
const REASON_SECTIONS: Record<
  RouteCoverageReason,
  { heading: string; fix: string }
> = {
  excluded: {
    heading:
      "Excluded from the change-feed (ExcludeFromChangeFeed) — no trigger:",
    fix: "remove the table's ExcludeFromChangeFeed contribution (accept its feed churn), or replace it with a change producer (defineChangeProducer) to keep the churn off the feed",
  },
  rollup: {
    heading:
      "Derived-table rollup — feed-exempt by design (a read-cache of its source, never triggered):",
    fix: "key the resource off the rollup's SOURCE table instead (the change flows from there)",
  },
  uncovered: {
    heading:
      "No trigger installed — a typo, a VIEW name (it must be the BASE table, not the view), or a dropped/nonexistent table:",
    fix: "correct the table to a real triggered base table",
  },
};

const REASON_ORDER: readonly RouteCoverageReason[] = [
  "excluded",
  "rollup",
  "uncovered",
];

/** Loud, actionable message grouping every dead route by its reason. */
export function formatUncoveredRouteError(
  violations: readonly RouteCoverageViolation[],
): string {
  const sections: string[] = [];
  for (const reason of REASON_ORDER) {
    const group = violations
      .filter((v) => v.reason === reason)
      .map((v) => `  • ${v.key}  →  ${v.via} "${v.table}"`)
      .sort();
    if (group.length === 0) continue;
    const { heading, fix } = REASON_SECTIONS[reason];
    sections.push(
      "",
      heading,
      ...group,
      `  Fix: ${fix}, or make the resource a plain push resource (no routes, hydrate-on-mount — like Studio's sample-rows).`,
    );
  }
  return [
    `[change-feed] Dead scope policy: ${violations.length} live-state ` +
      `resource table(s) depend on a table the change-feed installs no trigger ` +
      `on. A resource is reached only by a change to such a table, which an ` +
      `untriggered table can NEVER produce — so these resources silently degrade ` +
      `to hydrate-on-mount while claiming live scoping:`,
    ...sections,
  ].join("\n");
}

/**
 * Throw loudly (blocking boot) if any resource depends on a table with no
 * change source: no trigger the change-feed installed, and no change producer.
 * Called from the change-feed's boot install (`installFeed`) after
 * `rebuildTriggers` has populated the triggered set.
 */
export function assertRouteTablesCovered(
  scoped: readonly ScopedResourceTable[],
  coveredTables: ReadonlySet<string>,
  excludedTables: ReadonlySet<string>,
  exemptTables: ReadonlySet<string>,
): void {
  const dead = findUncoveredRouteTables(
    scoped,
    coveredTables,
    excludedTables,
    exemptTables,
  );
  if (dead.length > 0) {
    throw new Error(formatUncoveredRouteError(dead));
  }
}

/** One table a reach plan reads outside the change feed (server-core's `unfedResourceTables`). */
export interface UnfedResourceTable {
  key: string;
  table: string;
}

/**
 * A reach plan's `unfed` tables are read outside the change feed BY
 * DECLARATION, so each must be one the feed was told to skip
 * (`ExcludeFromChangeFeed`). A covered or produced table there is a write the
 * feed reports and the resource drops — a missed change dressed as a declared
 * one; any other name (a typo, a view) declares nothing real. Throws (blocks
 * boot), like A1′.
 */
export function assertUnfedTablesOptedOut(
  unfed: readonly UnfedResourceTable[],
  optedOut: ReadonlySet<string>,
): void {
  const wrong = unfed.filter((u) => !optedOut.has(u.table));
  if (wrong.length === 0) return;
  throw new Error(
    `[change-feed] resources declare reads outside the change feed of tables the feed was not told to skip — ` +
      `each must be opted out (ExcludeFromChangeFeed), or routed as an ordinary read:\n` +
      wrong.map((u) => `  - ${u.key}: "${u.table}"`).join("\n"),
  );
}
