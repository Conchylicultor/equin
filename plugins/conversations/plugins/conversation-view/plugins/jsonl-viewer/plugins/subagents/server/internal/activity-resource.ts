import { serveValue } from "@plugins/network/plugins/live/server";
import {
  conversationChainTag,
  watchPaths,
} from "@plugins/conversations/plugins/transcript-watcher/server";
import type { SubagentActivityRow } from "../../core";
import { subagentActivity } from "../../core";
import {
  evictConversationJoin,
  evictSubagentActivity,
  primeSubagentActivity,
  subagentActivityMemo,
} from "./caches";
import { resolveActivityTargets, scanActivity } from "./activity-scan";

// Pushed (the declaration's default) as a delivery choice: the payload is a
// handful of small rows, the same for every subscriber, and observed by every
// card in the conversation the moment it changes. Correctness does not rest on
// it — the ETag and the value come from one memo, so this value is sound under
// `load: "on-demand"` too.
export const subagentActivityServed = serveValue(subagentActivity, {
  source: "external",
  changes: "notified",
  loader: ({ id }) => subagentActivityMemo.get(id),
  revalidate: ({ id }) => subagentActivityMemo.signature(id),
  // Watch the conversation's `subagents/` directories while a card is on
  // screen. The start is synchronous (`watchPaths` hands back its unsubscribe
  // at once), so the sub-ack is never held behind it.
  whileSubscribed: ({ id }, notify) => {
    const unsub = watchPaths<SubagentActivityRow[]>(
      {
        key: `subagent-activity:${id}`,
        // Derived from the session chain, so a recorded session switch must reach
        // this room too — not just the conversation's own transcript room.
        refreshOn: conversationChainTag(id),
        // DISCOVERED membership: the `subagents/` directories decide which files
        // exist. Routing by exact path would drop a sub-agent's file at the
        // moment it is created — which is every sub-agent, every time — and the
        // card would never appear.
        resolve: () => resolveActivityTargets(id),
        // The RAW scan, not the memo: the room IS the authoritative reader, and
        // it primes the memo with the pair it just produced. Reading through the
        // memo here would probe a second signature and prime under a different
        // one than the value was read at.
        read: () => scanActivity(id),
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
});
