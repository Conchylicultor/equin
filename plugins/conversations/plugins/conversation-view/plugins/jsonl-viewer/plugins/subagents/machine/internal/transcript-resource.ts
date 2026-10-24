import { serveValue } from "@plugins/network/plugins/live/machine";
import { sliceRange } from "@plugins/network/plugins/live/server";
import {
  conversationChainTag,
  watchPaths,
} from "@plugins/conversations/plugins/transcript-watcher/server";
import { transcriptChainReads } from "@plugins/conversations/plugins/transcript-source/server";
import {
  subagentTranscript,
  type SubagentTranscript,
  type SubagentTranscriptQuery,
} from "../../core";
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
import {
  subagentTranscriptMeta,
  subagentTranscriptRows,
} from "./transcript-pages";

/** The memoized read of the sub-agent a question names. */
function transcriptOf({
  id,
  by,
  key,
}: SubagentTranscriptQuery): Promise<SubagentTranscript> {
  return subagentTranscriptMemo.get(transcriptMemoKey(id, { by, key }));
}

// Paged like the conversation's own transcript (`jsonl-events`): every page and
// the meta read the sub-agent's events through ONE memo, primed by the room
// before anything is notified, so a recompute slices memory and a change ships
// the rows it touched — never the whole transcript.
export const subagentTranscriptServed = serveValue(subagentTranscript, {
  source: "external",
  changes: "notified",
  // The pages and the meta resolve the transcript chain from Postgres before
  // reading files: a write there re-reads every subscribed page whole.
  reads: transcriptChainReads,
  loader: async (query, range) =>
    sliceRange(
      subagentTranscript,
      subagentTranscriptRows(await transcriptOf(query)),
      range,
    ),
  meta: async (query) => subagentTranscriptMeta(await transcriptOf(query)),
  // Watch the sub-agent's file (or, while it is still starting, its
  // directories) while any page of its pane is open — once per question,
  // however its pages split. A synchronous start: `watchPaths` hands back its
  // unsubscribe at once.
  whileSubscribed: ({ id, by, key }, notify) => {
    const ref = { by, key };
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
