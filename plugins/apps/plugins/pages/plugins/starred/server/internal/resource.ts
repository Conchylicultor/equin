import { serveCollection } from "@plugins/network/plugins/live/server";
import { starredPages } from "../../shared/resources";
import { pageBlocksStarred } from "./tables";

// Served from the extension handle (its wire columns — `blockId` is the
// `parent_id` PK, `createdAt` a `wireTimestamps` entry of the shape). Starring
// is an entrant of the whole set (one refill + one `orderOf`) and unstarring an
// exit with no load; never a whole-set reload.
//
// Re-starring an already-starred page changes nothing: `pageBlocksStarred` is
// presence-only, so `upsert(pageId, {})` on conflict only rewrites the key with
// its own value (a no-op) — no column the set reads moves.
export const starredPagesServed = serveCollection(starredPages, {
  from: pageBlocksStarred,
});
