import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { WebStorageSlots } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { StorageFailureCollector } from "./components/storage-failure-collector";

export default {
  description:
    "Web-storage failure collector: drains the web-storage primitive's storageFailureReportSink into a deduped crash report (source client-storage, one row per owner and reason) for every write refused by an owner's cap or by the browser, and every stored entry that failed its owner's schema.",
  contributions: [
    WebStorageSlots.Root({
      component: StorageFailureCollector,
      companion: true,
    }),
  ],
} satisfies PluginDefinition;
