import { serveValue } from "@plugins/network/plugins/live/server";
import type { LiveValue } from "@plugins/network/plugins/live/core";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  followedTranscriptChain,
  transcriptChainFollows,
} from "@plugins/conversations/plugins/transcript-source/server";
import {
  conversationEvents,
  conversationEventsSignature,
  derivedFromEvents,
} from "./conversation-events";

/**
 * Serve a value derived from a conversation's WHOLE transcript — an outline, a
 * total, the shells it started — so the page reads that small value instead of
 * the transcript, of which it only ever holds the latest window.
 *
 * `derive` runs on the server over the events in memory (the one watch per
 * conversation, `conversation-events.ts`), once per change. A change that
 * leaves the events unchanged sends nothing: `revalidate` is the events'
 * signature, so the runtime's same-ETag check (D8) skips the recompute — and
 * one that changes the events but leaves the derived value equal notifies
 * nothing at all (`derivedFromEvents`: the watch derives it and compares).
 *
 * The transcript chain's facts are FOLLOWED (`transcriptChainFollows`): a
 * session recorded on this conversation, or its tail moving, recomputes its
 * tuples alone; the watch follows a session switch by itself.
 *
 * The value is declared by its owner (`liveValue(key, { schema, params:
 * ["id"] })`, `id` the conversation id) and this serves it; the owner spreads
 * `.declare` into its contributions.
 */
export function serveTranscriptValue<T>(
  value: LiveValue<T, { id: string }>,
  derive: (events: readonly JsonlEvent[]) => T,
) {
  const derived = derivedFromEvents(
    ({ id }: { id: string }) => id,
    (_params, events) => derive(events),
  );
  return serveValue(value, {
    source: "external",
    changes: "notified",
    follows: (follow) => transcriptChainFollows(follow),
    loader: async (params, { followed }) =>
      derived.load(
        params,
        await conversationEvents(params.id, followedTranscriptChain(followed)),
      ),
    revalidate: ({ id }, { followed }) =>
      conversationEventsSignature(id, followedTranscriptChain(followed)),
    whileSubscribed: (params, notify) => derived.watch(params, notify),
  });
}
