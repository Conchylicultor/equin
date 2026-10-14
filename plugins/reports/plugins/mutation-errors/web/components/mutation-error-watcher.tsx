import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  EndpointUnsupportedError,
  getEndpointErrorMessage,
} from "@plugins/infra/plugins/endpoints/web";
import { toast } from "@plugins/shell/plugins/notifications/web";

export function MutationErrorWatcher() {
  const queryClient = useQueryClient();

  useEffect(() => {
    return queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== "updated") return;
      if (event.action.type !== "error") return;
      if (event.mutation.options.meta?.suppressError) return;
      // The host refused an endpoint it does not serve and told the user itself.
      if (event.action.error instanceof EndpointUnsupportedError) return;
      // reacts to this tab's local mutation cache, not shared live-state.
      toast({
        type: "mutation-error",
        title: "Request failed",
        description: getEndpointErrorMessage(event.action.error),
        variant: "warning",
      });
    });
  }, [queryClient]);

  return null;
}
