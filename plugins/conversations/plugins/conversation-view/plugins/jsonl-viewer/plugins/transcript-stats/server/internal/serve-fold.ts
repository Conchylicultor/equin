import { serveValue } from "@plugins/network/plugins/live/server";
import {
  followedTranscriptChain,
  transcriptChainFollows,
} from "@plugins/conversations/plugins/transcript-source/server";
import {
  conversationEvents,
  derivedFromEvents,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server";
import { foldEvents, type TranscriptFold } from "../../core";

/**
 * Serve a stat's `fold.before`: the fold of a conversation's transcript up to
 * the seq the page's window starts at. The events before a window seldom move
 * when a line is appended (a rewind, a session switch, a later result filling
 * an earlier call), so the value is notified only when the fold itself moved
 * (`derivedFromEvents`) — a stat's step is a cheap pass over in-memory events.
 */
export function serveTranscriptFold<S>(fold: TranscriptFold<S>) {
  const derived = derivedFromEvents(
    ({ id, before }: { id: string; before: string }) => `${id}\u0000${before}`,
    ({ before }, events) =>
      foldEvents(fold, fold.init(), events.slice(0, Number(before))),
  );
  return serveValue(fold.before, {
    source: "external",
    changes: "notified",
    // The transcript chain's facts, followed: a session recorded on this
    // conversation recomputes its folds alone; the watch follows the switch
    // by itself.
    follows: (follow) => transcriptChainFollows(follow),
    loader: async (params, { followed }) =>
      derived.load(
        params,
        await conversationEvents(params.id, followedTranscriptChain(followed)),
      ),
    whileSubscribed: (params, notify) => derived.watch(params, notify),
  });
}
