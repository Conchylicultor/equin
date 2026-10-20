import { serveCollection } from "@plugins/network/plugins/live/server";
import { conversationPrepromptRows } from "../../core";
import { conversationPreprompt } from "./tables";

// Server half of the per-conversation preprompt read: the lookup-only
// collection served from the extension entity (its wire columns —
// `conversationId` is the `parent_id` PK, and `text` binds to the
// `prompt_text` column by its property name). The `:rows` point routing sends
// a snapshot write to the one conversation's tuple alone, so a write never
// sweeps the table.
export const conversationPrepromptRowsServed = serveCollection(
  conversationPrepromptRows,
  { from: conversationPreprompt },
);
