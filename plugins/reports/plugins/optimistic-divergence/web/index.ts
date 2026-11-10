import { Core, type PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { OptimisticDivergenceCollector } from "./components/optimistic-divergence-collector";
import { OptimisticDivergenceKindView } from "./components/optimistic-divergence-kind-view";

export default {
  description:
    "Optimistic-divergence collector: drains the optimistic-mutation primitive's report sink (a server-acked op superseded by newer truth, or stalled unconfirmed) into a deduped report, plus the Debug → Reports summary view.",
  contributions: [
    Core.Root({ component: OptimisticDivergenceCollector, scope: "page" }),
    Reports.KindView({
      match: "optimistic-divergence",
      component: OptimisticDivergenceKindView,
    }),
  ],
} satisfies PluginDefinition;
