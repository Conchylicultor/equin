import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { TableLayoutRequirement } from "@plugins/framework/plugins/server-core/core";
import {
  getCoveredTables,
  rebuildTriggers,
  type TriggerExclusions,
} from "./triggers";
import {
  assertNoUnroutedResources,
  assertRouteTablesCovered,
  assertUnfedTablesOptedOut,
  relationReadTables,
  type RelationResourceRead,
  type ScopedResourceTable,
  type UnfedResourceTable,
} from "./route-coverage";
import { assertRouteLayoutsInstalled } from "./route-layout";
import { assertNoOtherDeferredTriggers } from "./txn-end";
import {
  assertRelationBasesSourced,
  createRelationBases,
  type RelationGraph,
} from "./relation-bases";
import {
  assertNoTriggerOnProduced,
  assertProducedTablesDeclared,
} from "./produced-tables";

/** Everything the feed's install reads from the booted graph, passed in. */
export interface FeedInstallInputs {
  /** Rollups, opt-outs and produced tables: the feed installs no trigger on them. */
  exclusions: TriggerExclusions;
  /** The routed tables' trigger layouts (`routedTableRequirements()`). */
  layouts: readonly TableLayoutRequirement[];
  /** Every table a routed resource's routes name (`scopedResourceTables()`). */
  scoped: readonly ScopedResourceTable[];
  /** Every table a reach plan reads outside the feed (`unfedResourceTables()`). */
  unfed: readonly UnfedResourceTable[];
  /** Every relation a reach plan reads whole (`relationResourceReads()`). */
  relationReads: readonly RelationResourceRead[];
  /** Every DB-backed resource declaring no reads (`unroutedResourceKeys()`). */
  unrouted: readonly string[];
  /** The views' and rollups' read graph, which relation bases expand through. */
  relations: RelationGraph;
}

/**
 * Install the feed's triggers on `db` and enforce its boot invariants against
 * the resources and change producers that read it. The body of change-feed's
 * `onReadyBlocking`, parametrized on the database and on the contribution /
 * registry sets (which only a booted process can read), so a suite runs it
 * against a throwaway database with its own declarations.
 *
 *  0. D6: every DB-backed resource declares its reads (none is unrouted).
 *  1. A2′ (declarations) + A3p: a produced table is neither opted out nor a
 *     rollup, and no route on it needs a carried column.
 *  2. The trigger rebuild (`rebuildTriggers`), produced tables denylisted.
 *  3. A2′ (catalog): no `live_state_*` trigger survived on a produced table;
 *     no deferred trigger but the end marker sits on a triggered table or on
 *     the changelog (it would NOTIFY after the marker).
 *  4. A1′: every route table of a routed resource has a change source — a
 *     trigger the rebuild installed, or a mounted change producer — and so
 *     does every base of a relation a reach plan reads whole; every table a
 *     reach plan reads outside the feed is one the feed was told to skip.
 *  5. D35: every base table a view or rollup reaches has a change source, or
 *     is opted out.
 *  6. A3: every routed table's installed triggers carry what its routes read.
 */
export async function installFeed(
  db: NodePgDatabase,
  inputs: FeedInstallInputs,
): Promise<void> {
  const {
    exclusions,
    layouts,
    scoped,
    unfed,
    relationReads,
    unrouted,
    relations,
  } = inputs;
  assertNoUnroutedResources(unrouted);
  assertProducedTablesDeclared(
    exclusions.produced,
    exclusions.optedOut,
    exclusions.feedExempt,
    layouts,
  );
  await rebuildTriggers(db, exclusions, layouts);
  await assertNoTriggerOnProduced(db, exclusions.produced);
  // The end marker must be the transaction's last NOTIFY: a deferred trigger
  // writing at commit would emit after it (./txn-end).
  await assertNoOtherDeferredTriggers(db, getCoveredTables());
  // Reject dead routing (A1′): a routed resource (`routes` / `reach`) is
  // reached only through its route tables, so a route table with no change
  // source can never deliver; only a triggered or produced table produces a
  // change. `getCoveredTables()` is the authoritative triggered set — just
  // populated by `rebuildTriggers` above — so this one check subsumes the
  // ExcludeFromChangeFeed case AND catches typo / view / rollup / nonexistent
  // tables; the exclusion + exempt sets only classify the reason for the
  // diagnostic. Throws loudly (blocks boot) rather than warning: it is always a
  // definite bug, never transient drift. A legitimate base table is present in
  // the covered set by construction, so a miss is never a false positive. A
  // reach plan's relation reads join it through their bases — a write to any
  // is what reaches the value. See ./route-coverage.
  assertRouteTablesCovered(
    [
      ...scoped,
      ...relationReadTables(relationReads, createRelationBases(relations)),
    ],
    new Set([...getCoveredTables(), ...exclusions.produced]),
    exclusions.optedOut,
    exclusions.feedExempt,
  );
  assertUnfedTablesOptedOut(unfed, exclusions.optedOut);
  // D35: a reader of a view or rollup is reached through the relation's bases
  // (a reach plan's relation reads, the drift guard's fail-open), so each base
  // must itself produce changes: a trigger, a producer — or an explicit
  // opt-out, whose readers accept hydrate-on-mount by declaration.
  assertRelationBasesSourced(
    relations,
    new Set([
      ...getCoveredTables(),
      ...exclusions.produced,
      ...exclusions.optedOut,
    ]),
  );
  // A3: every column a route maps through, filters or matches on is carried by
  // its table's installed trigger — read back from the catalog (the trigger
  // arguments), so a layout the routes derive but the database does not carry
  // blocks boot instead of recomputing its readers FULL forever. A produced
  // table has no trigger to read, and A3p above already refused a carried
  // column on one.
  await assertRouteLayoutsInstalled(db, layouts);
}
