import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getEndpointErrorMessage } from "@plugins/infra/plugins/endpoints/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";

export function MutationErrorWatcher() {
  const toast = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    return queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== "updated") return;
      if (event.action.type !== "error") return;
      if (event.mutation.options.meta?.suppressError) return;
      // reacts to this tab's local mutation cache, not shared live-state.
      toast({
        type: "mutation-error",
        title: "Request failed",
        description: getEndpointErrorMessage(event.action.error),
        variant: "warning",
      });
    });
  }, [queryClient, toast]);

  return null;
}
