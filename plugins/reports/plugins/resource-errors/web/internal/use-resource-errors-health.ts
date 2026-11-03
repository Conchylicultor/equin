import type { HealthStatus } from "@plugins/shell/plugins/health-report/core";
import { useFailingResources } from "@plugins/network/plugins/live/plugins/live-state/web";
import { resourceErrorsVerdict } from "./resource-errors-health";

/** The health report's "Live reads" row: how many reads on this page are failing. */
export function useResourceErrorsHealth(): HealthStatus {
  return resourceErrorsVerdict(useFailingResources());
}
