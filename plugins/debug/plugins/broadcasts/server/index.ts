import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleWrite } from "./internal/handle-write";
import { broadcastEntriesServed } from "./internal/entries-served";
import { writeBroadcasts } from "../shared/endpoints";

export default {
  description:
    "View and edit the CLI's broadcasts.json from the UI: the broadcasts.entries live value (watched through the dir hub) and its PUT.",
  httpRoutes: {
    [writeBroadcasts.route]: handleWrite,
  },
  contributions: [...broadcastEntriesServed.declare],
} satisfies ServerPluginDefinition;
