import { serveCollection } from "@plugins/network/plugins/live/server";
import { conversationUsageById } from "../../core";
import { conversationUsage } from "./tables";

// The cost stat's read: a primary-key seek of the conversation's totals, and
// the `:rows` point routing sends a recount to its own conversation's readers
// alone.
export const conversationUsageByIdServed = serveCollection(
  conversationUsageById,
  { from: conversationUsage },
);
