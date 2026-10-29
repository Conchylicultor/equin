import {
  EndpointError,
  useEndpointMutation,
} from "@plugins/infra/plugins/endpoints/web";
import { useLiveMutation } from "@plugins/network/plugins/live/web";
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
  const patchTrigger = useLiveMutation(patchTriggerEndpoint);
  const deleteTrigger = useLiveMutation(deleteTriggerEndpoint);
  return {
    retryJob: (id: string) => settled(retry.mutateAsync({ params: { id } })),
    cancelJob: (id: string) => settled(cancel.mutateAsync({ params: { id } })),
    runJobNow: (name: string) =>
      settled(runNow.mutateAsync({ body: { kind: "job", name } })),
    // Predicted: the trigger list shows the change at once, nothing to await.
    setTriggerEnabled: (id: string, enabled: boolean) =>
      patchTrigger.mutate({ params: { id }, body: { enabled } }),
    deleteTrigger: (id: string) => deleteTrigger.mutate({ params: { id } }),
  };
}
