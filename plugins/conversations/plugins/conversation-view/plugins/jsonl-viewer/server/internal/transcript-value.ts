import { serveValue } from "@plugins/network/plugins/live/server";
import type { LiveValue } from "@plugins/network/plugins/live/core";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  conversationEvents,
  watchConversationEvents,
} from "./conversation-events";

/**
 * Serve a value derived from a conversation's WHOLE transcript — an outline, a
 * total, the shells it started — so the page reads that small value instead of
 * the transcript, of which it only ever holds the latest window.
 *
 * `derive` runs on the server over the events in memory (the one watch per
 * conversation, `conversation-events.ts`), once per change. A change that
 * leaves the derived value equal sends nothing: the previous object is handed
 * back, which the runtime recognises as "the very value every holder holds".
 *
 * The value is declared by its owner (`liveValue(key, { schema, params:
 * ["id"] })`, `id` the conversation id) and this serves it; the owner spreads
 * `.declare` into its contributions.
 */
export function serveTranscriptValue<T>(
  value: LiveValue<T, { id: string }>,
  derive: (events: readonly JsonlEvent[]) => T,
) {
  const last = new Map<string, { json: string; value: T }>();
  return serveValue(value, {
    source: "external",
    changes: "notified",
    loader: async ({ id }) => {
      const next = derive(await conversationEvents(id));
      const json = JSON.stringify(next);
      const previous = last.get(id);
      if (previous?.json === json) return previous.value;
      last.set(id, { json, value: next });
      return next;
    },
    whileSubscribed: ({ id }, notify) => {
      const stop = watchConversationEvents(id, notify);
      return () => {
        stop();
        last.delete(id);
      };
    },
  });
}
