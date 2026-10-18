import { serveValue } from "@plugins/network/plugins/live/server";
import {
  transcriptChainReads,
  watchTranscript,
} from "@plugins/conversations/plugins/transcript-watcher/server";
import { jsonlEvents } from "../../core";
import {
  evictJsonlEvents,
  jsonlEventsMemo,
  primeJsonlEvents,
} from "./jsonl-events-cache";

// Pushed (the declaration's default): a change ships the whole event array, and
// the client renders it without a refetch. That is a DELIVERY choice, not a
// correctness crutch: the ETag and the value come from one authority
// (jsonl-events-cache.ts), so the value is sound under `load: "on-demand"` too.
// Switching is a pure frame-size decision, which is the entire point of that
// binding.
export const jsonlEventsServed = serveValue(jsonlEvents, {
  source: "external",
  changes: "notified",
  // The loader resolves the transcript chain from Postgres before reading files.
  reads: transcriptChainReads,
  // The ETag and the value are produced by ONE authority: `jsonlEventsMemo` is a
  // `createSignedMemo` binding `transcriptChainSignature` to `readJsonlEventsFromChain`
  // at its single declaration site, both over the chain `resolveConversationTranscriptPaths`
  // returns. `revalidate` and `loader` are therefore provably the same function of the
  // same inputs, not two probes agreeing by convention — which is what they were.
  loader: ({ id }) => jsonlEventsMemo.get(id),
  revalidate: ({ id }) => jsonlEventsMemo.signature(id),
  // Watch the conversation's transcript chain while it is on screen. The start is
  // synchronous (`watchTranscript` hands back its unsubscribe at once), so the
  // sub-ack is never held behind it.
  whileSubscribed: ({ id }, notify) => {
    const unsub = watchTranscript(id, ({ events, signature }) => {
      // Prime BEFORE notify: the watcher holds both halves of the pair, and the
      // recompute that `notify` schedules calls the loader — which is then a memo
      // hit instead of a second full read + parse of the chain the watcher just read.
      primeJsonlEvents(id, signature, events);
      notify();
    });
    return () => {
      unsub();
      // Pure lifecycle cleanup. A late prime landing across this evict is harmless:
      // the entry it resurrects carries its own signature, and any reader probes the
      // CURRENT one, so a surviving entry is served only if it still matches the
      // chain on disk.
      evictJsonlEvents(id);
    };
  },
});
