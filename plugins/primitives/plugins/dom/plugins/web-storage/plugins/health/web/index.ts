import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { WebStorageSlots } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { HealthReport } from "@plugins/shell/plugins/health-report/web";
import { StorageDetail } from "./components/storage-detail";
import { StorageFailureToast } from "./components/storage-failure-toast";
import { useStorageHealth } from "./internal/use-storage-health";

export default {
  description:
    "Makes browser storage visible: an error toast once per owner per page load when a write is refused (over the owner's cap, the area full, or storage blocked — the value then lives only in memory), and the health report's Browser storage row (critical when the browser refused a write, attention when an owner hit or nears its cap; its detail lists every owner's use against its cap plus the legacy and unowned keys).",
  contributions: [
    WebStorageSlots.Root({ component: StorageFailureToast, companion: true }),
    HealthReport.Row({
      kind: "status",
      id: "browser-storage",
      title: "Browser storage",
      order: 40,
      useStatus: useStorageHealth,
      component: StorageDetail,
    }),
  ],
} satisfies PluginDefinition;
