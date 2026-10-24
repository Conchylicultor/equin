import { useLive } from "@plugins/network/plugins/live/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import { gatewayDrift } from "../../core";
import { gatewayVerdict } from "./gateway-health";

/** The health report's Gateway row. One subscription to a pushed scalar. */
export function useGatewayHealth(): HealthStatus {
  return gatewayVerdict(useLive(gatewayDrift));
}
