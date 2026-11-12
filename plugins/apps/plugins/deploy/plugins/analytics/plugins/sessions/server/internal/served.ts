import type { LiveCutKey } from "@plugins/network/plugins/live/core";
import { serveCollection } from "@plugins/network/plugins/live/server";
import type { Filter } from "@plugins/network/plugins/live/plugins/filter/core";
import { tableMirrorReplicas } from "@plugins/database/plugins/table-mirror/plugins/replica/server";
import {
  onSiteMirrorApplied,
  readSiteMirror,
} from "@plugins/apps/plugins/deploy/plugins/site-mirror/plugins/pull/server";
import {
  ANALYTICS_MIRROR_SET_ID,
  type VisitCut,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import {
  analyticsMirrorTables,
  countVisits,
  readVisitGroups,
  readVisitsById,
  readVisitWindow,
  type VisitReads,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/server";
import {
  deploymentSessions,
  parseSessionKey,
  sessionRowOf,
  startedAtKeyText,
} from "../../core";

// Every filterable field but the scope is a visit column collect's SQL runs.
const { deploymentId: _scope, ...VISIT_FILTERABLE } =
  deploymentSessions.filterable;

/** A question's site and the rest of its filter, which collect runs on that site's copy. */
interface Scoped {
  deploymentId: string;
  where: Filter | undefined;
}

/** Is `f` the scope clause, `deploymentId = <site>`? */
function scopeOf(f: Filter): string | null {
  return "column" in f &&
    f.column === "deploymentId" &&
    f.op === "eq" &&
    typeof f.operand === "string"
    ? f.operand
    : null;
}

/**
 * Split a question's canonical filter into its site (a top-level
 * `deploymentId = <site>` clause, required: every site has its own copy, so a
 * read across sites has no spelling) and the rest. A question without one is
 * a caller's bug — every reader scopes by the site page it is on.
 */
export function splitScope(where: Filter | undefined): Scoped {
  const missing = () =>
    new Error(
      `deploy-analytics.sessions: every read names one site — where: { deploymentId } at the top of its filter (got ${JSON.stringify(where)})`,
    );
  if (where === undefined) throw missing();
  const own = scopeOf(where);
  if (own !== null) return { deploymentId: own, where: undefined };
  if (!("and" in where)) throw missing();
  const scopes = where.and.flatMap((c) => {
    const s = scopeOf(c);
    return s === null ? [] : [s];
  });
  const [deploymentId, ...more] = scopes;
  if (deploymentId === undefined || more.length > 0) throw missing();
  const rest = where.and.filter((c) => scopeOf(c) === null);
  return {
    deploymentId,
    where:
      rest.length === 0
        ? undefined
        : rest.length === 1
          ? rest[0]
          : { and: rest },
  };
}

/** A window cut (`[startedAt text, key]`) as collect's visit cut. */
function visitCutOf(cut: LiveCutKey | undefined): VisitCut | undefined {
  if (cut === undefined) return undefined;
  const [startedAt, key] = cut;
  if (typeof startedAt !== "string" || typeof key !== "string")
    throw new Error(
      `deploy-analytics.sessions: a cut without a start instant and key: ${JSON.stringify(cut)}`,
    );
  return { startedAt, id: parseSessionKey(key).visitId };
}

/**
 * `fn` on the site's copy of collect's tables, as of the copy's own moment
 * (the box's clock at the last applied page — what "still live" is measured
 * against, so the answer moves when the copy does, never with this
 * computer's clock). The tab mounts the list only once the copy is whole
 * (`site-mirror.status`'s `copied`), so a read before that is a broken
 * assumption, loudly.
 */
async function onCopy<T>(
  deploymentId: string,
  fn: (tx: VisitReads, asOf: Date) => Promise<T>,
): Promise<T> {
  const read = await readSiteMirror(
    deploymentId,
    ANALYTICS_MIRROR_SET_ID,
    (tx, { sourceNow }) => fn(tx, sourceNow),
  );
  if (!read.ready)
    throw new Error(
      `deploy-analytics.sessions: ${deploymentId}'s copy of its analytics is not readable yet (${read.phase}) — the tab reads it only once site-mirror.status says it is copied`,
    );
  return read.value;
}

// Notified, not the change feed: the copy lives in a replica schema the feed
// does not cover, and the replica announces every applied page itself
// (`onSiteMirrorApplied`, one LISTEN while any tuple is held). A lost session
// (`null`) may have missed one — re-read everything, as for any page.
export const deploymentSessionsServed = serveCollection(deploymentSessions, {
  source: "external",
  changes: "notified",
  throttleMs: 1000,
  whileSubscribed: (notify) =>
    onSiteMirrorApplied({ setId: ANALYTICS_MIRROR_SET_ID }, () => notify()),
  // What the answers read: the copy's tables (named as collect's own — the
  // replica schema holds them under the same names) and the replica's state
  // row. Every change to either arrives through the replica's NOTIFY above,
  // in the transaction that applied it — never through the change feed.
  reads: {
    tables: [],
    reason: "a site's copy of its analytics, read through its replica",
    notified: {
      relations: [tableMirrorReplicas, ...analyticsMirrorTables],
      reason:
        "the copy (and whether it is whole) moves only when a pull applies a page, which the replica announces (onReplicaApplied)",
    },
  },
  keyText: { startedAt: startedAtKeyText },
  window: async (q) => {
    const { deploymentId, where } = splitScope(q.where);
    const [order, ...rest] = q.orderBy;
    if (order === undefined || order[0] !== "startedAt" || rest.length > 0)
      throw new Error(
        `deploy-analytics.sessions: ordered by startedAt alone — got ${JSON.stringify(q.orderBy)}`,
      );
    const after = visitCutOf(q.after);
    const until = visitCutOf(q.until);
    const visits = await onCopy(deploymentId, (tx, asOf) =>
      readVisitWindow(
        tx,
        {
          where,
          filterable: VISIT_FILTERABLE,
          direction: order[1],
          ...(after ? { after } : {}),
          ...(until ? { until } : {}),
          limit: q.limit,
        },
        asOf,
      ),
    );
    return visits.map((s) => sessionRowOf(deploymentId, s));
  },
  rows: async (keys) => {
    const bySite = new Map<string, string[]>();
    for (const key of keys) {
      const { deploymentId, visitId } = parseSessionKey(key);
      bySite.set(deploymentId, [...(bySite.get(deploymentId) ?? []), visitId]);
    }
    const rows = await Promise.all(
      [...bySite].map(async ([deploymentId, ids]) => {
        const visits = await onCopy(deploymentId, (tx, asOf) =>
          readVisitsById(tx, ids, asOf),
        );
        return visits.map((s) => sessionRowOf(deploymentId, s));
      }),
    );
    return rows.flat();
  },
  groups: async (q) => {
    const { groupBy } = q;
    if (groupBy === "deploymentId")
      throw new Error(
        "deploy-analytics.sessions: grouping by site has no meaning — every read is one site's",
      );
    const { deploymentId, where } = splitScope(q.where);
    return onCopy(deploymentId, (tx) =>
      readVisitGroups(tx, {
        where,
        filterable: VISIT_FILTERABLE,
        groupBy,
        limit: q.limit,
      }),
    );
  },
  count: async (q) => {
    const { deploymentId, where } = splitScope(q.where);
    return onCopy(deploymentId, (tx) =>
      countVisits(tx, { where, filterable: VISIT_FILTERABLE }),
    );
  },
});
