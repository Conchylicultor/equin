import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  EndpointError,
  getEndpointErrorMessage,
} from "@plugins/infra/plugins/endpoints/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";

/**
 * Any mutation that failed with nobody handling it (no `onError`, no
 * `suppressError`): "Couldn't save your change", until dismissed — an error
 * the user must know about. The mutation layer carries no user-facing name
 * for what was being saved, nor its subject, so the headline cannot say
 * "Rename failed" (research/2026-10-25-global-notifications-in-user-terms.md);
 * the status and the server's words are the developer detail.
 */
export function MutationErrorWatcher() {
  const toast = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    return queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== "updated") return;
      if (event.action.type !== "error") return;
      if (event.mutation.options.meta?.suppressError) return;
      const err = event.action.error;
      // reacts to this tab's local mutation cache, not shared live-state.
      toast({
        type: "mutation-error",
        category: "other",
        title: "Couldn't save your change",
        description: "",
        detail:
          err instanceof EndpointError
            ? `HTTP ${err.status}: ${getEndpointErrorMessage(err)}`
            : getEndpointErrorMessage(err),
        variant: "error",
      });
    });
  }, [queryClient, toast]);

  return null;
}
