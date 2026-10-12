import { serveValue } from "@plugins/network/plugins/live/server";
import {
  conversationChainTag,
  watchPaths,
} from "@plugins/conversations/plugins/transcript-watcher/server";
import type { SubagentRef, SubagentTranscript } from "../../core";
import { SubagentRefSchema, subagentTranscript } from "../../core";
import {
  evictSubagentTranscript,
  primeSubagentTranscript,
  subagentTranscriptMemo,
  transcriptMemoKey,
} from "./caches";
import {
  readSubagentTranscript,
  resolveTranscriptTargets,
} from "./transcript-read";

/**
 * The ref a subscription names. Every value param reaches the server as a plain
 * string, so `by` is re-parsed here rather than trusted to be `call` | `agent`.
 */
function refOf({ by, key }: { by: string; key: string }): SubagentRef {
  return SubagentRefSchema.parse({ by, key });
}

export const subagentTranscriptServed = serveValue(subagentTranscript, {
  source: "external",
  changes: "notified",
  loader: ({ id, ...ref }) =>
    subagentTranscriptMemo.get(transcriptMemoKey(id, refOf(ref))),
  revalidate: ({ id, ...ref }) =>
    subagentTranscriptMemo.signature(transcriptMemoKey(id, refOf(ref))),
  // Watch the sub-agent's file (or, while it is still starting, its
  // directories) while its pane is open. A synchronous start: `watchPaths`
  // hands back its unsubscribe at once.
  whileSubscribed: ({ id, ...params }, notify) => {
    const ref = refOf(params);
    const memoKey = transcriptMemoKey(id, ref);
    const unsub = watchPaths<SubagentTranscript>(
      {
        key: `subagent-transcript:${id}:${ref.by}:${ref.key}`,
        refreshOn: conversationChainTag(id),
        resolve: () => resolveTranscriptTargets(id, ref),
        // The RAW read, not the memo — the room primes the memo with the pair it
        // just produced (see activity-resource.ts).
        read: () => readSubagentTranscript(id, ref),
      },
      ({ value, signature }) => {
        primeSubagentTranscript(memoKey, signature, value);
        notify();
      },
    );
    return () => {
      unsub();
      evictSubagentTranscript(memoKey);
    };
  },
});
