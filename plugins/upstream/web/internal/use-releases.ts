import { useLive } from "@plugins/network/plugins/live/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import { upstreamPublisherStatus } from "@plugins/upstream/plugins/release/core";
import { releasesHealth } from "./releases-view";

/** The releases row's `useStatus`: the pushed publisher status, read resident. */
export function useReleasesHealth(): HealthStatus {
  return releasesHealth(useLive(upstreamPublisherStatus));
}
