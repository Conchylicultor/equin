import { serveCollection } from "@plugins/network/plugins/live/server";
import { conversationProgressRows } from "../../core";
import { conversationProgress } from "./tables";

// Server half of the per-conversation progress read: the lookup-only
// collection served from the extension entity (its wire columns —
// `conversationId` is the `parent_id` PK). The `:rows` point routing sends a
// progress insert / reclassify to the one conversation's tuple alone, so a
// phase change never sweeps the table.
export const conversationProgressRowsServed = serveCollection(
  conversationProgressRows,
  { from: conversationProgress },
);
