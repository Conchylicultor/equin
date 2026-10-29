import { serveValue } from "@plugins/network/plugins/live/machine";
import { sliceRange } from "@plugins/network/plugins/live/server";
import {
  conversationChainTag,
  resolveTranscriptPathsOf,
  watchPaths,
} from "@plugins/conversations/plugins/transcript-watcher/server";
import {
  followedTranscriptChain,
  transcriptChainFollows,
} from "@plugins/conversations/plugins/transcript-source/server";
import type { TranscriptChain } from "@plugins/conversations/plugins/transcript-source/core";
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
  readSubagentTranscriptOf,
  resolveTranscriptTargets,
} from "./transcript-read";
import {
  subagentTranscriptMeta,
  subagentTranscriptRows,
} from "./transcript-pages";

/** The memoized read of the sub-agent a question names, under the parent's followed chain. */
async function transcriptOf(
  { id, by, key }: SubagentTranscriptQuery,
  chain: TranscriptChain,
): Promise<SubagentTranscript> {
  return subagentTranscriptMemo.get(transcriptMemoKey(id, { by, key }), {
    input: await resolveTranscriptPathsOf(id, chain),
  });
}

// Paged like the conversation's own transcript (`jsonl-events`): every page and
// the meta read the sub-agent's events through ONE memo, primed by the room
// before anything is notified, so a recompute slices memory and a change ships
// the rows it touched — never the whole transcript.
export const subagentTranscriptServed = serveValue(subagentTranscript, {
  source: "external",
  changes: "notified",
  // The parent's transcript chain, followed: a session recorded on this
  // conversation re-reads its own questions' pages alone.
  follows: (follow) => transcriptChainFollows(follow),
  loader: async (query, range, { followed }) =>
    sliceRange(
      subagentTranscript,
      subagentTranscriptRows(
        await transcriptOf(query, followedTranscriptChain(followed)),
      ),
      range,
    ),
  meta: async (query, { followed }) =>
    subagentTranscriptMeta(
      await transcriptOf(query, followedTranscriptChain(followed)),
    ),
  // Watch the sub-agent's file (or, while it is still starting, its
  // directories) while any page of its pane is open — once per question,
  // however its pages split. A synchronous start: `watchPaths` hands back its
  // unsubscribe at once. The room resolves from the followed chain it was
  // started with (a recorded session restarts it over the new one).
  whileFollowing: {
    over: (followed) => followedTranscriptChain(followed),
    start: ({ id, by, key }, { over: chain, notify }) => {
      const ref = { by, key };
      const parentPaths = () => resolveTranscriptPathsOf(id, chain);
      const memoKey = transcriptMemoKey(id, ref);
      const unsub = watchPaths<SubagentTranscript>(
        {
          key: `subagent-transcript:${id}:${ref.by}:${ref.key}`,
          refreshOn: conversationChainTag(id),
          resolve: async () =>
            resolveTranscriptTargets(id, ref, await parentPaths()),
          // The RAW read, not the memo — the room primes the memo with the pair it
          // just produced (see activity-resource.ts).
          read: async () =>
            readSubagentTranscriptOf(id, ref, await parentPaths()),
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
  },
});
