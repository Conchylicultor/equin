import { createRefcountHub } from "@plugins/packages/plugins/refcount-hub/core";
import { TranscriptSource } from "@plugins/conversations/plugins/transcript-source/server";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  evictJsonlEvents,
  jsonlEventsMemo,
  primeJsonlEvents,
} from "./jsonl-events-cache";

// A conversation's events on the server, for every value served from them: the
// `jsonl-events` pages and the whole-transcript values other plugins derive
// (the outline, the stats, …), which the page reads instead of the whole array.
//
// ONE transcript watch per conversation however many of those values are
// subscribed (a refcounted hub): its snapshot primes the shared memo before any
// of them is told, so their recomputes all read the snapshot the watch just
// read. The memo entry is evicted with the last holder — never by one value
// leaving while another still reads it.
const hub = createRefcountHub<void>((conversationId, emit) => {
  const unsub = TranscriptSource.get().watch(
    conversationId,
    ({ events, signature }) => {
      primeJsonlEvents(conversationId, signature, events);
      emit();
    },
  );
  return () => {
    unsub();
    // A late prime landing across this evict is harmless: the entry carries
    // its own signature, and a reader probes the CURRENT one.
    evictJsonlEvents(conversationId);
  };
});

/**
 * Call `onChange` after every change to the conversation's transcript, until
 * the returned stop; the memo already holds the new events when it runs. Starts
 * synchronously — a `whileSubscribed` body.
 */
export function watchConversationEvents(
  conversationId: string,
  onChange: () => void,
): () => void {
  const hold = hub.acquire(conversationId, onChange);
  return () => hold.release();
}

/** The conversation's events now (a memory read while it is watched). */
export function conversationEvents(
  conversationId: string,
): Promise<JsonlEvent[]> {
  return jsonlEventsMemo.get(conversationId);
}

/** Moves whenever `conversationEvents` would answer differently — a value's `revalidate`. */
export function conversationEventsSignature(
  conversationId: string,
): Promise<string> {
  return jsonlEventsMemo.signature(conversationId);
}
