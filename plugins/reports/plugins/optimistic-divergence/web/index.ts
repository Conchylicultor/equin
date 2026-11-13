import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { optimisticDivergenceReportSink } from "@plugins/network/plugins/live/web";
import { drain } from "@plugins/primitives/plugins/report-sink/web";
import { ReportSinks } from "@plugins/reports/plugins/collectors/web";
import { collectOptimisticDivergence } from "./internal/optimistic-divergence-collector";
import { OptimisticDivergenceKindView } from "./components/optimistic-divergence-kind-view";

export default {
  description:
    "Optimistic-divergence collector: drains the optimistic-mutation primitive's report sink (a server-acked op superseded by newer truth, or stalled unconfirmed) into a deduped report, plus the Debug → Reports summary view.",
  contributions: [
    ReportSinks.Collector({
      from: "network.live",
      collect: drain(
        optimisticDivergenceReportSink,
        collectOptimisticDivergence,
      ),
      companion: true,
    }),
    Reports.KindView({
      match: "optimistic-divergence",
      component: OptimisticDivergenceKindView,
    }),
  ],
} satisfies PluginDefinition;
