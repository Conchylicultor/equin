import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  useConversationSubagents,
  type SubagentStatus,
} from "./use-subagent-statuses";

type ToolCallEvent = Extract<JsonlEvent, { kind: "tool-call" }>;

/**
 * One sub-agent, as the card that launched it sees it.
 *
 * A thin reading of {@link useConversationSubagents}: the resources, the
 * gating and both directions of the row ⇄ `Agent`-call join live there, so a
 * card and a list of every sub-agent can never disagree about what one of them
 * is doing. Every card in a conversation calls this on the same id, and that is
 * deliberate — `useLive` is a TanStack Query wrapper, so N callers on
 * identical params share ONE query and ONE subscription.
 */
export function useSubagentStatus({
  conversationId,
  toolUseId,
  agentToolEvent,
}: {
  conversationId: string | null;
  toolUseId: string;
  /** The parent's `Agent` tool-call event — the FOREGROUND completion signal. */
  agentToolEvent: ToolCallEvent | undefined;
}): SubagentStatus {
  const subagents = useConversationSubagents(conversationId);
  switch (subagents.kind) {
    case "pending":
    case "failed":
      return subagents;
    case "known":
      return subagents.statusOf({ toolUseId, agentToolEvent });
  }
}
