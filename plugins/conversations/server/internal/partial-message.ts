import { serveValue } from "@plugins/network/plugins/live/server";
import {
  _conversations,
  getConversationRuntime,
} from "@plugins/tasks/plugins/tasks-core/server";
import { conversationPartialMessage, type PartialMessage } from "../../core";
import { Runtime } from "./runtime";

/** Each watched conversation's streaming message, as its runtime last reported it. */
const held = new Map<string, PartialMessage | null>();

/**
 * `conversations.partial-message`: the text the agent is streaming, held in
 * memory while a page watches (its runtime's `watchPartial`, opened on the
 * first reader and stopped after the last). Throttled to one push per 50 ms:
 * the model writes faster than a reader reads, and each push is the whole
 * message so far.
 */
export const partialMessageServed = serveValue(conversationPartialMessage, {
  source: "external",
  changes: "notified",
  throttleMs: 50,
  reads: {
    tables: [_conversations],
    reason:
      "the conversation's runtime row picks which runtime to watch; the text itself is in memory, pushed by that runtime",
  },
  loader: ({ id }) => held.get(id) ?? null,
  whileSubscribed: async ({ id }, notify) => {
    const row = await getConversationRuntime(id);
    if (!row) throw new Error(`Conversation ${id} not found`);
    const stop = Runtime.get(row.runtime).watchPartial(id, (message) => {
      held.set(id, message);
      notify();
    });
    return () => {
      stop();
      held.delete(id);
    };
  },
});
