import { useLive } from "@plugins/network/plugins/live/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import { pinDrift } from "../../core";
import { pinDriftVerdict } from "./pin-health";

/** The health report's Pinned binaries row. One subscription to a pushed value. */
export function usePinDriftHealth(): HealthStatus {
  return pinDriftVerdict(useLive(pinDrift));
}
