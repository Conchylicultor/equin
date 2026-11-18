import { useLive } from "@plugins/network/plugins/live/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import { githubEventsStatus } from "../../core";
import { githubEventsHealth } from "./status-view";

/** The GitHub events row's `useStatus`: the pushed forwarder status. */
export function useGitHubEventsHealth(): HealthStatus {
  return githubEventsHealth(useLive(githubEventsStatus));
}
