import type { HealthStatus } from "@plugins/shell/plugins/health-report/core";
import { useStorageUsage } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { storageVerdict } from "./storage-health";

/** The health report's "Browser storage" row. */
export function useStorageHealth(): HealthStatus {
  return storageVerdict(useStorageUsage());
}
