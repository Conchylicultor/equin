import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { storageFailureReportSink } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { drain } from "@plugins/primitives/plugins/report-sink/web";
import { ReportSinks } from "@plugins/reports/plugins/collectors/web";
import { collectStorageFailure } from "./internal/storage-failure-collector";

export default {
  description:
    "Web-storage failure collector: drains the web-storage primitive's storageFailureReportSink into a deduped crash report (source client-storage, one row per owner and reason) for every write refused by an owner's cap or by the browser, and every stored entry that failed its owner's schema.",
  contributions: [
    ReportSinks.Collector({
      from: "primitives.dom.web-storage",
      collect: drain(storageFailureReportSink, collectStorageFailure),
      companion: true,
    }),
  ],
} satisfies PluginDefinition;
