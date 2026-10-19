import { serveCollection } from "@plugins/network/plugins/live/server";
import { spawnFailureRows } from "../../core";
import { spawnFailures } from "./tables";

// Served from the extension handle: the loader reads only the subscribed ids
// (`WHERE parent_id IN (ids)`), and a write routes to the tuples naming that
// conversation.
export const spawnFailureRowsServed = serveCollection(spawnFailureRows, {
  from: spawnFailures,
});
