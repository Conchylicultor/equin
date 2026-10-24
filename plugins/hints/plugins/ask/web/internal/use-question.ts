import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { useConversation } from "@plugins/conversations/web";

/**
 * The question run `conversationId` was asked — its conversation's title —
 * or null while that row is not known (loading, a failed read, a run that no
 * longer exists): the caller then names the card instead of the question.
 */
export function useRunQuestion(conversationId: string | null): string | null {
  return foldResource(useConversation(conversationId), {
    loading: () => null,
    error: () => null,
    ready: (c) => c?.title ?? null,
  });
}
