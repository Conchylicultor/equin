import { useCallback } from "react";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import type { ConversationEntry } from "@plugins/conversations/core";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { markViewed, resumeHibernated } from "../../shared/endpoints";

/** What marking a conversation viewed needs to know about it. */
export type ViewedConversation = Pick<ConversationEntry, "id" | "hibernatedAt">;

// Record that the user opened the conversation: stamp it viewed (resets the
// idle timer) and, when its row says it is hibernated, resume it.
//
// A refused resume is a toast. The resume is transparent when it works, not
// when it fails: a silent failure here is how a conversation ends up with no
// live session (or a session started in the wrong directory) while the UI shows
// nothing at all. The conversation's status is deliberately left alone by the
// server, so it stays listed and can be recovered.
//
// Bound through `useFetchEndpoint()`, so inside a scoped transport (a demo
// scope) both requests reach that scope's server, never the page's.
export function useMarkConversationViewed(): (
  conversation: ViewedConversation,
) => Promise<void> {
  const fetchEndpoint = useFetchEndpoint();
  const toast = useToast();
  return useCallback(
    async ({ id, hibernatedAt }: ViewedConversation) => {
      await fetchEndpoint(markViewed, { id });
      if (hibernatedAt === null) return;
      const result = await fetchEndpoint(resumeHibernated, { id });
      switch (result.kind) {
        case "unavailable":
          // No computer behind this transport (the in-browser demo): there is
          // no agent session to resume, and the transcript renders without one.
          // Nothing to do — and nothing to tell the user, who asked for nothing.
          return;
        case "ok":
          if (result.value.kind !== "blocked") return;
          toast({
            type: "conversation-resume-blocked",
            category: "conversations",
            title: "Can't resume conversation",
            description: result.value.message,
            variant: "error",
          });
          return;
      }
    },
    [fetchEndpoint, toast],
  );
}
