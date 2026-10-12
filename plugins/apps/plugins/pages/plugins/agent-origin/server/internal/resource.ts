import { serveCollection } from "@plugins/network/plugins/live/server";
import { agentPages } from "../../shared/resources";
import { pageBlocksOrigin } from "./tables";

// Served from the extension handle (its wire columns — `blockId` is the
// `parent_id` PK, `createdAt` a `wireTimestamps` entry of the shape). Every
// column of the marker is immutable post-insert — a marker is written once by
// the create hook and deleted by the sweep, never updated. Marking a page is an
// entrant of the whole set (one refill + one `orderOf`) and sweeping it an exit
// with no load; never a whole-set reload.
export const agentPagesServed = serveCollection(agentPages, {
  from: pageBlocksOrigin,
});
