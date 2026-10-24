import { sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import {
  BROWSER_RECENTS_LIMIT,
  browserRecents,
  type BrowserRecent,
} from "../../shared/resources";
import { browserHistory } from "./tables";

// Most-recent visit per distinct URL, newest first, capped at BROWSER_RECENTS_LIMIT.
// `DISTINCT ON (url)` keeps the latest row per url (the inner order picks it);
// the outer query then sorts those by recency.
async function loadRecents(): Promise<BrowserRecent[]> {
  const latest = db
    .selectDistinctOn([browserHistory.url], {
      url: browserHistory.url,
      title: browserHistory.title,
      visitedAt: browserHistory.visitedAt,
    })
    .from(browserHistory)
    .orderBy(browserHistory.url, sql`${browserHistory.visitedAt} desc`)
    .as("latest");

  return db
    .select({
      url: latest.url,
      title: latest.title,
      visitedAt: latest.visitedAt,
    })
    .from(latest)
    .orderBy(sql`${latest.visitedAt} desc`)
    .limit(BROWSER_RECENTS_LIMIT);
}

// Recomputed (and pushed whole) on every write to `browser_history`, the table
// its declared `reads` name.
export const browserRecentsServed = serveValue(browserRecents, {
  source: "db",
  reads: {
    tables: [browserHistory],
    reason:
      "the latest visit per distinct url, so any visit written may change the 12 most recent",
  },
  loader: loadRecents,
});
