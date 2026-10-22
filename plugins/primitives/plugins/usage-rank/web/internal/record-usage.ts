import { useCallback } from "react";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { recordUsageEndpoint } from "../../core";

/** Record one use of `(namespace, key)` — see `useRecordUsage`. */
export type RecordUsage = (namespace: string, key: string) => void;

/**
 * The recorder of one use of `(namespace, key)`, through the subtree's
 * transport — fire-and-forget, so a click handler never waits on the
 * round-trip and never has to be `async`. Stable per transport.
 *
 * `void` (not a swallowing `.catch`) is deliberate: a failed record surfaces as
 * an unhandled rejection the reports plugin files, exactly like the
 * playback-history `recordPlay` precedent. Ordering is derived from server
 * truth, so there is nothing to roll back on failure — the use simply did not
 * count.
 */
export function useRecordUsage(): RecordUsage {
  const fetchEndpoint = useFetchEndpoint();
  return useCallback(
    (namespace: string, key: string) => {
      // eslint-disable-next-line endpoints/no-void-fetch-endpoint -- genuine fire-and-forget: recording a use is a silent side-signal of an action the user took for another reason, and the ordering it feeds is self-correcting (the next use re-records, and a lost record only means that use did not count). A toast would report a failure the user cannot act on, about an operation they never asked for.
      void fetchEndpoint(recordUsageEndpoint, {}, { body: { namespace, key } });
    },
    [fetchEndpoint],
  );
}
