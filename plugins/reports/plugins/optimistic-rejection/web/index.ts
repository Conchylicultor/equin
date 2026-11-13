import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { optimisticRejectionSink } from "@plugins/network/plugins/live/web";
import { drain } from "@plugins/primitives/plugins/report-sink/web";
import { ReportSinks } from "@plugins/reports/plugins/collectors/web";
import { collectOptimisticRejection } from "./internal/optimistic-rejection-collector";
import { OptimisticRejectionKindView } from "./components/optimistic-rejection-kind-view";

export default {
  description:
    "Optimistic-rejection collector: drains the optimistic-mutation primitive's rejection sink (a write the server permanently refused — the optimistic op already dropped, or a detached write lost) into an error toast telling the user their edit was not saved, and a deduped report, plus the Debug → Reports summary view.",
  contributions: [
    ReportSinks.Collector({
      from: "network.live",
      collect: drain(optimisticRejectionSink, collectOptimisticRejection),
      companion: true,
    }),
    Reports.KindView({
      match: "optimistic-rejection",
      component: OptimisticRejectionKindView,
    }),
  ],
} satisfies PluginDefinition;
