import { useCallback } from "react";
import { z } from "zod";
import {
  EndpointError,
  getEndpointErrorMessage,
  useFetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web";
import {
  useToast,
  type NotificationActionKind,
} from "@plugins/shell/plugins/notifications/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { resumeConversationEndpoint } from "../../core";

/** The conversation a resume is about: its id and its name as shown now. */
export interface ResumeSubject {
  id: string;
  name: string;
}

const errorIcon = symbol("error");

/**
 * The resume handler throws `HttpError(409, msg)` and the server serializes
 * the bare message as the body; `getEndpointErrorMessage` reads only
 * `body.message`, so a plain-string body would fall back to "HTTP 409".
 */
function resumeErrorText(err: EndpointError): string {
  return typeof err.body === "string" && err.body
    ? err.body
    : getEndpointErrorMessage(err);
}

/**
 * Resume a gone conversation (`claude --resume`). The one place a resume is
 * started from the browser — the prompt's Restore, and a failed resume's own
 * Retry — so its failure always reads the same: "Couldn't resume conversation"
 * about the conversation, with Retry, the server's reason as the developer
 * detail. Success says nothing: the user is looking at the conversation come
 * back. Resolves either way; a refusal is the notification, not a throw.
 */
export function useResumeConversation(): (
  conv: ResumeSubject,
) => Promise<void> {
  const fetchEndpoint = useFetchEndpoint();
  const toast = useToast();
  return useCallback(
    async (conv: ResumeSubject) => {
      const fail = (detail: string) =>
        toast({
          type: "conversation",
          category: "conversations",
          icon: errorIcon,
          title: "Couldn't resume conversation",
          description: "",
          subjectId: conv.id,
          subjectName: conv.name,
          detail,
          variant: "error",
          action: {
            kind: "resume",
            payload: { conversationId: conv.id, conversationName: conv.name },
          },
        });
      try {
        const result = await fetchEndpoint(resumeConversationEndpoint, {
          id: conv.id,
        });
        if (result.kind === "unavailable") fail(result.message);
      } catch (err) {
        if (!(err instanceof EndpointError)) throw err;
        fail(`HTTP ${err.status}: ${resumeErrorText(err)}`);
      }
    },
    [fetchEndpoint, toast],
  );
}

const ResumePayloadSchema = z.object({
  conversationId: z.string(),
  conversationName: z.string(),
});

/** `resume`: Retry a failed resume (`payload: { conversationId, conversationName }`). */
export const resumeAction: NotificationActionKind = {
  kind: "resume",
  label: "Retry",
  useRun: function useRetryResume() {
    const resume = useResumeConversation();
    return (payload) => {
      const { conversationId, conversationName } =
        ResumePayloadSchema.parse(payload);
      void resume({ id: conversationId, name: conversationName });
    };
  },
};
