import { useMemo } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { keyOfUsage, usageStats } from "../../core";

/**
 * The `limit` keys of `namespace` used most recently, newest first — for a
 * caller with no candidate set to rank (`useUsageOrder` orders a set it is
 * given; this finds the set): an emoji picker's Recent row, out of every emoji
 * there is.
 *
 * Recency, not frecency: a "Recent" row that put a key used fifty times last
 * month ahead of the one just picked would not be what it says. A bounded
 * window of the `usageStats` collection (`where` namespace, newest
 * `lastUsedAt` first), so the read is O(limit) and live — a pick lands in it.
 */
export function useRecentUsage(
  namespace: string,
  limit: number,
): ResourceResult<readonly string[]> {
  const result = useLive(usageStats, {
    where: { namespace },
    orderBy: [["lastUsedAt", "desc"]],
    limit,
  });
  return useMemo(
    () =>
      mapResource(result, (rows) =>
        rows.map((row) => keyOfUsage(namespace, row.usageKey)),
      ),
    [result, namespace],
  );
}
