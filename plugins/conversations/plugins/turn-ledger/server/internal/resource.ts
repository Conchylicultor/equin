import { serveCollection } from "@plugins/network/plugins/live/server";
import { conversationTurns } from "../../core/resources";
import { conversationTurnsEntity } from "./tables";

// Every row, newest first per conversation: the web renders a card for the
// states that still need one, so a settled row leaves the card with the write
// that settled it.
export const conversationTurnsServed = serveCollection(conversationTurns, {
  from: conversationTurnsEntity,
});
