import { serveValue } from "@plugins/network/plugins/live/machine";
import {
  conversationChainTag,
  resolveTranscriptPathsOf,
  watchPaths,
} from "@plugins/conversations/plugins/transcript-watcher/server";
import type { TranscriptChain } from "@plugins/conversations/plugins/transcript-source/core";
import {
  followedTranscriptChain,
  transcriptChainFollows,
} from "@plugins/conversations/plugins/transcript-source/server";
import type { SubagentActivityRow } from "../../core";
import { subagentActivity } from "../../core";
import {
  evictConversationJoin,
  evictSubagentActivity,
  primeSubagentActivity,
  subagentActivityMemo,
} from "./caches";
import { activityTargetsIn, scanActivityIn } from "./activity-scan";
import { subagentDirsOf } from "./discovery";

/** The conversation's sub-agent roots under the chain its value follows. */
async function rootsOf(id: string, chain: TranscriptChain): Promise<string[]> {
  return subagentDirsOf(await resolveTranscriptPathsOf(id, chain));
}

// Pushed (the declaration's default) as a delivery choice: the payload is a
// handful of small rows, the same for every subscriber, and observed by every
// card in the conversation the moment it changes. Correctness does not rest on
// it — the ETag and the value come from one memo, so this value is sound under
// `load: "on-demand"` too.
export const subagentActivityServed = serveValue(subagentActivity, {
  source: "external",
  changes: "notified",
  // The transcript chain's facts, followed: its files decide which `subagents/`
  // directories are read, and a session recorded on another conversation
  // reaches nothing here.
  follows: (follow) => transcriptChainFollows(follow),
  loader: async ({ id }, { followed }) =>
    subagentActivityMemo.get(id, {
      input: await resolveTranscriptPathsOf(
        id,
        followedTranscriptChain(followed),
      ),
    }),
  revalidate: async ({ id }, { followed }) =>
    subagentActivityMemo.signature(id, {
      input: await resolveTranscriptPathsOf(
        id,
        followedTranscriptChain(followed),
      ),
    }),
  // Watch the conversation's `subagents/` directories while a card is on
  // screen. The start is synchronous (`watchPaths` hands back its unsubscribe
  // at once), so the sub-ack is never held behind it. The room resolves from
  // the chain it was started with (`over`): a recorded session that moves the
  // chain restarts the room over the new one, and a chain row the tail
  // already named restarts nothing.
  whileFollowing: {
    over: (followed) => followedTranscriptChain(followed),
    start: ({ id }, { over: chain, notify }) => {
      const unsub = watchPaths<SubagentActivityRow[]>(
        {
          key: `subagent-activity:${id}`,
          // Derived from the session chain: a recorded session switch re-resolves
          // the room (the new chain itself arrives by the restart above).
          refreshOn: conversationChainTag(id),
          // DISCOVERED membership: the `subagents/` directories decide which files
          // exist. Routing by exact path would drop a sub-agent's file at the
          // moment it is created — which is every sub-agent, every time — and the
          // card would never appear.
          resolve: async () => activityTargetsIn(await rootsOf(id, chain)),
          // The RAW scan, not the memo: the room IS the authoritative reader, and
          // it primes the memo with the pair it just produced. Reading through the
          // memo here would probe a second signature and prime under a different
          // one than the value was read at.
          read: async () => scanActivityIn(id, await rootsOf(id, chain)),
        },
        ({ value, signature }) => {
          // Prime BEFORE notify: the room holds both halves of the pair, so the
          // loader the `notify` schedules is a memo hit instead of a second scan.
          primeSubagentActivity(id, signature, value);
          notify();
        },
      );
      return () => {
        unsub();
        // Pure lifecycle cleanup. A late prime landing across this evict is
        // harmless: the entry it resurrects carries its own signature, and any
        // reader probes the CURRENT one, so a surviving entry is served only if it
        // still matches disk.
        evictSubagentActivity(id);
        evictConversationJoin(id);
      };
    },
  },
});
