import { serveCollection } from "@plugins/network/plugins/live/server";
import { usageStats } from "../../core";
import { usageStatsEntity } from "./tables";

// Server half of the collection: every row field binds to its `_usageStats`
// column by name. The `:rows` point read loads only the subscribed id set
// (`WHERE usage_key IN (ids)`), and its routing sends a `recordUsage` upsert to
// a tuple iff the changed usage keys intersect its set — so recording one use
// never sweeps the whole table. An id set is unordered; ranking it is the
// CLIENT's job (`sortByUsage`), because the comparison must decay to the
// reader's `now`. The window (one namespace, newest `last_used_at` first,
// `useRecentUsage`) is bounded by its declared limit; the table itself is
// bounded by the one-year retention sweep.
export const usageStatsServed = serveCollection(usageStats, {
  from: usageStatsEntity,
});
