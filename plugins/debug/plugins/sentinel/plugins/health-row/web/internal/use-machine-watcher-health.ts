import { useLive } from "@plugins/network/plugins/live/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import { sentinelStatus } from "@plugins/debug/plugins/sentinel/core";
import { machineWatcherVerdict } from "./machine-watcher-health";

/**
 * The health report's Machine watcher row. Cheap: one subscription to a small
 * pushed value every backend serves from main's host-global status file. It
 * changes only when that file does, so the hook holds no timer.
 */
export function useMachineWatcherHealth(): HealthStatus {
  return machineWatcherVerdict(useLive(sentinelStatus));
}
