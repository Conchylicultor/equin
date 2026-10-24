import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";

// One row per distinct recently-visited URL, newest first. `visitedAt` is the
// most recent visit time; it serializes to ISO over the wire and `z.coerce.date`
// rebuilds a Date on the client (same precedent as the page editor's resources).
export const BrowserRecentSchema = z.object({
  url: z.string(),
  title: z.string(),
  visitedAt: z.coerce.date(),
});
export type BrowserRecent = z.infer<typeof BrowserRecentSchema>;

// How many recent urls the start page lists — the loader's LIMIT, and the cap
// its schema declares.
export const BROWSER_RECENTS_LIMIT = 12;

// The start page's "Recent" list, as ONE value rather than a collection: it is
// a derivation (the latest visit per distinct url, then the newest
// BROWSER_RECENTS_LIMIT of those), not rows of one table, so there is no row
// set to window. Capped: the loader's LIMIT is the schema's max. No
// placeholder: before the first value lands the read is `pending`.
export const browserRecents = liveValue("browser-recents", {
  schema: cappedList(BrowserRecentSchema, { max: BROWSER_RECENTS_LIMIT }),
});
