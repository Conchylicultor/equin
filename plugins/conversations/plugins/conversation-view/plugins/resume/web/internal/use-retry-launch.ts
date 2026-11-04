import { useCallback } from "react";
import {
  EndpointError,
  getEndpointErrorMessage,
  useFetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { retryLaunchEndpoint } from "../../core";
import type { ResumeSubject } from "./use-resume-conversation";

const errorIcon = symbol("error");

/**
 * Retry the launch of a conversation that failed to start: the server re-runs
 * its spawn (workspace, then agent) and the row goes back to Starting. A
 * refusal (it is no longer a failed start, Claude Code is unavailable) is a
 * "Couldn't retry launch" notification about the conversation, the server's
 * reason as the developer detail; success says nothing — the status chip
 * turns to Starting. Resolves either way.
 */
export function useRetryLaunch(): (conv: ResumeSubject) => Promise<void> {
  const fetchEndpoint = useFetchEndpoint();
  const toast = useToast();
  return useCallback(
    async (conv: ResumeSubject) => {
      const fail = (detail: string) =>
        toast({
          type: "conversation",
          category: "conversations",
          icon: errorIcon,
          title: "Couldn't retry launch",
          description: "",
          subjectId: conv.id,
          subjectName: conv.name,
          detail,
          variant: "error",
        });
      try {
        const result = await fetchEndpoint(retryLaunchEndpoint, {
          id: conv.id,
        });
        if (result.kind === "unavailable") fail(result.message);
      } catch (err) {
        if (!(err instanceof EndpointError)) throw err;
        // The handler answers 409 with the bare message as the body.
        fail(
          `HTTP ${err.status}: ${typeof err.body === "string" && err.body ? err.body : getEndpointErrorMessage(err)}`,
        );
      }
    },
    [fetchEndpoint, toast],
  );
}
