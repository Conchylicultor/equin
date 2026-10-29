import { serveCollection } from "@plugins/network/plugins/live/server";
import { conversationSessions } from "../../core";
import { _conversationSessions } from "./tables";

/** How `conversation-sessions` binds: every row field a column of the table. */
export const conversationSessionsServeOptions = { from: _conversationSessions };

// One conversation's session chain (`conversationSessions`, scoped by
// `conversationId`), over the `conversation_sessions` table: an insert into a
// chain reaches that conversation's tuple alone.
export const conversationSessionsServed = serveCollection(
  conversationSessions,
  conversationSessionsServeOptions,
);
