import { createRefcountHub } from "@plugins/packages/plugins/refcount-hub/core";
import { TranscriptSource } from "@plugins/conversations/plugins/transcript-source/server";
import type {
  JsonlEvent,
  TranscriptChain,
} from "@plugins/conversations/plugins/transcript-source/core";
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
const hub = createRefcountHub<readonly JsonlEvent[]>((conversationId, emit) => {
  const unsub = TranscriptSource.get().watch(
    conversationId,
    ({ events, signature }) => {
      primeJsonlEvents(conversationId, signature, events);
      emit(events);
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
  const hold = hub.acquire(conversationId, () => onChange());
  return () => hold.release();
}

/**
 * A value derived from a conversation's events, per tuple, notified only when
 * IT moved — not on every line appended to the transcript.
 *
 * Events are rebuilt whole on every change (a later line can rewrite an earlier
 * event: a tool result, a merged message, a rewind), so nothing cheaper than
 * the derived value itself says soundly whether it moved. The watch derives it
 * from the events it just read and compares it with the value last served:
 * equal, it notifies nothing (no recompute, no no-op push); moved, it notifies
 * and the loader serves it. `load` hands an equal value back as the object last
 * served, which the runtime sends as nothing.
 *
 * The watch reads the watched chain, the loader the followed one: when they
 * disagree the watch notifies (the safe direction), and a chain change
 * recomputes through its follows by itself.
 */
export function derivedFromEvents<P extends { id: string }, T>(
  key: (params: P) => string,
  derive: (params: P, events: readonly JsonlEvent[]) => T,
): {
  /** The value for `params` over `events` — the loader's half. */
  load: (params: P, events: readonly JsonlEvent[]) => T;
  /** Watch conversation `params.id`, notifying when the value moved — a `whileSubscribed` body. */
  watch: (params: P, notify: () => void) => () => void;
} {
  const last = new Map<string, { json: string; value: T }>();
  return {
    load: (params, events) => {
      const next = derive(params, events);
      const json = JSON.stringify(next);
      const k = key(params);
      const previous = last.get(k);
      if (previous?.json === json) return previous.value;
      last.set(k, { json, value: next });
      return next;
    },
    watch: (params, notify) => {
      const k = key(params);
      const hold = hub.acquire(params.id, (events) => {
        const previous = last.get(k);
        if (
          previous !== undefined &&
          JSON.stringify(derive(params, events)) === previous.json
        ) {
          return;
        }
        notify();
      });
      return () => {
        hold.release();
        last.delete(k);
      };
    },
  };
}

/**
 * The conversation's events now (a memory read while it is watched), read
 * from `chain` — the facts the calling value followed
 * (`transcriptChainFollows` → `followedTranscriptChain`), so the value's
 * reach names exactly what the read depends on.
 */
export function conversationEvents(
  conversationId: string,
  chain: TranscriptChain,
): Promise<JsonlEvent[]> {
  return jsonlEventsMemo.get(conversationId, { input: chain });
}

/** Moves whenever `conversationEvents` would answer differently — a value's `revalidate`. */
export function conversationEventsSignature(
  conversationId: string,
  chain: TranscriptChain,
): Promise<string> {
  return jsonlEventsMemo.signature(conversationId, { input: chain });
}
