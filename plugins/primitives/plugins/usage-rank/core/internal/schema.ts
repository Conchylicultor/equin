import { z } from "zod";
import { fieldsToZodObject } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { floatField } from "@plugins/fields/plugins/float/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { liveCollection } from "@plugins/network/plugins/live/core";

/**
 * One (namespace, key) usage rollup. `score` is the frecency score as of
 * `lastUsedAt` (NOT as of now — decay it with `decayedScore` before comparing);
 * `useCount` is the raw lifetime count, kept for display/debugging only.
 * `lastUsedAt` crosses the wire as an ISO string, so it is coerced back to a
 * `Date` on read (the `conversation-category` precedent).
 */
const USAGE_STAT_LISTED = {
  namespace: textField({ label: "Namespace" }),
};
const USAGE_STAT_CARRIED = {
  usageKey: textField(),
  score: floatField(),
  useCount: floatField(),
  lastUsedAt: dateField(),
};
export const UsageStatSchema = fieldsToZodObject({
  ...USAGE_STAT_CARRIED,
  ...USAGE_STAT_LISTED,
});
export type UsageStat = z.infer<typeof UsageStatSchema>;

/**
 * The collection over `usage_stats`, read two ways:
 *
 * - by an explicit usage-key set, `useLive(usageStats, { ids })` —
 *   `useUsageOrder` coalesces the visible keys into ONE tuple — so a read costs
 *   O(subscribed ids) and a `recordUsage` write recomputes only the tuples
 *   whose set contains the touched key (the `:rows` point routing), never the
 *   whole table. Rows key on `usageKey`, which IS the table's single-column pk;
 * - as a bounded window of ONE namespace's most recently used keys
 *   (`useRecentUsage`): the answer to "what did I use last" when the caller
 *   has no candidate set to rank — an emoji picker's Recent row, out of every
 *   emoji there is. `where` on `namespace`, newest `lastUsedAt` first, a small
 *   limit.
 *
 * NOT preloaded: the server cannot know a client's id set at snapshot time,
 * and the default window (every namespace) is never what anyone reads.
 * `useUsageOrder` covers that one round-trip with its persistent-draft order
 * cache.
 */
export const usageStats = liveCollection("usage-stats", {
  fields: USAGE_STAT_LISTED,
  carry: { fields: USAGE_STAT_CARRIED },
  id: "usageKey",
  sortable: ["lastUsedAt"],
  default: { orderBy: [["lastUsedAt", "desc"]], limit: 20 },
  maxLimit: 100,
});
