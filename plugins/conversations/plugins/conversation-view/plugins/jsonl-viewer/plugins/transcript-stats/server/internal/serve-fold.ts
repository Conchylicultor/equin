import { serveValue } from "@plugins/network/plugins/live/server";
import {
  conversationEvents,
  watchConversationEvents,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server";
import { foldEvents, type TranscriptFold } from "../../core";

/**
 * Serve a stat's `fold.before`: the fold of a conversation's transcript up to
 * the seq the page's window starts at. The events before a window do not move
 * when a line is appended, so the value is pushed only when they do (a rewind,
 * a session switch): an equal fold is handed back as the object last served,
 * which the runtime sends as nothing.
 */
export function serveTranscriptFold<S>(fold: TranscriptFold<S>) {
  const last = new Map<string, { json: string; value: S }>();
  const tupleKey = (id: string, before: string) => `${id}\u0000${before}`;
  return serveValue(fold.before, {
    source: "external",
    changes: "notified",
    loader: async ({ id, before }) => {
      const events = await conversationEvents(id);
      const next = foldEvents(
        fold,
        fold.init(),
        events.slice(0, Number(before)),
      );
      const key = tupleKey(id, before);
      const json = JSON.stringify(next);
      const previous = last.get(key);
      if (previous?.json === json) return previous.value;
      last.set(key, { json, value: next });
      return next;
    },
    whileSubscribed: (params, notify) => {
      const stop = watchConversationEvents(params.id, notify);
      return () => {
        stop();
        last.delete(tupleKey(params.id, params.before));
      };
    },
  });
}
