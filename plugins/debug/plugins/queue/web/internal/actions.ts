import {
  EndpointError,
  useEndpointMutation,
} from "@plugins/infra/plugins/endpoints/web";
import { cancelJob, retryJob } from "@plugins/infra/plugins/jobs/core";
import {
  deleteTriggerEndpoint,
  patchTriggerEndpoint,
} from "@plugins/infra/plugins/events/core";
import { runBackgroundNowEndpoint } from "@plugins/infra/plugins/background/plugins/catalog/core";

/**
 * A failed request is already on screen — the endpoint layer's global toast
 * reports every unhandled mutation error — so the awaiting button only needs
 * to settle. Anything else is a bug and stays loud.
 */
function settled(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => undefined,
    (err: unknown) => {
      if (err instanceof EndpointError) return;
      throw err;
    },
  );
}

/** The queue's mutations, each a promise a `Button` can pend on. */
export function useQueueActions() {
  const retry = useEndpointMutation(retryJob);
  const cancel = useEndpointMutation(cancelJob);
  const runNow = useEndpointMutation(runBackgroundNowEndpoint);
  const patchTrigger = useEndpointMutation(patchTriggerEndpoint);
  const deleteTrigger = useEndpointMutation(deleteTriggerEndpoint);
  return {
    retryJob: (id: string) => settled(retry.mutateAsync({ params: { id } })),
    cancelJob: (id: string) => settled(cancel.mutateAsync({ params: { id } })),
    runJobNow: (name: string) =>
      settled(runNow.mutateAsync({ body: { kind: "job", name } })),
    setTriggerEnabled: (id: string, enabled: boolean) =>
      settled(patchTrigger.mutateAsync({ params: { id }, body: { enabled } })),
    deleteTrigger: (id: string) =>
      settled(deleteTrigger.mutateAsync({ params: { id } })),
  };
}
