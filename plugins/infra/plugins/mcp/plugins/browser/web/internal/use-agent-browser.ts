import { useLive } from "@plugins/network/plugins/live/web";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import { agentBrowserStatus } from "../../core";
import { agentBrowserVerdict } from "./agent-browser-health";

/** The machine's agent browser, pushed on every status-file rewrite. */
export function useAgentBrowserStatus() {
  return useLive(agentBrowserStatus);
}

/** The health report's Agent browser row. */
export function useAgentBrowserHealth(): HealthStatus {
  // Deadlines count down and errors age out of "recent"; a minute is enough.
  return agentBrowserVerdict(useAgentBrowserStatus(), useNow(60_000));
}
