import { conversationSessionsServed } from "@plugins/conversations/plugins/session-chain/server";
import { conversationSessionTailsServed } from "@plugins/tasks/plugins/tasks-core/server";
import type { FollowBuilder } from "@plugins/network/plugins/live/server";
import { transcriptChainOf, type TranscriptChain } from "../../core";

/**
 * The transcript chain's facts as `follows` (network/live), declared once:
 * every served value whose loader reads a conversation's transcript follows
 * the conversation's recorded session chain (`conversationSessions`, scoped by
 * conversation) and its live tail (`conversationSessionTails`, its
 * `claude_session_id`) — so a session recorded on, or a tail written to, one
 * conversation recomputes only that conversation's tuples, and a write to any
 * other column of `conversations` (the poller's `viewed`, a retitle) reaches
 * none. Its subject is anything naming the conversation as `id` (the params,
 * or a paged value's question).
 *
 * Spread into the value's `follows`, then hand `followed` to
 * `followedTranscriptChain`:
 *
 *   serveValue(v, {
 *     source: "external", changes: "notified",
 *     follows: (follow) => transcriptChainFollows(follow),
 *     loader: (p, { followed }) => read(p.id, followedTranscriptChain(followed)),
 *   });
 */
export function transcriptChainFollows<S extends { readonly id: string }>(
  follow: FollowBuilder<S>,
) {
  return {
    chainSessions: follow(conversationSessionsServed, ({ id }) => ({
      where: { conversationId: id },
    })),
    chainTail: follow(conversationSessionTailsServed, ({ id }) => ({
      ids: [id],
    })),
  };
}

/** The chain the rows `transcriptChainFollows` read name (`transcriptChainOf`). */
export function followedTranscriptChain(followed: {
  readonly chainSessions: readonly { readonly claudeSessionId: string }[];
  readonly chainTail: readonly { readonly claudeSessionId: string | null }[];
}): TranscriptChain {
  return transcriptChainOf(followed.chainSessions, followed.chainTail[0]);
}
