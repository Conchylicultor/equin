import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { OptimisticRejectionCollector } from "./components/optimistic-rejection-collector";
import { OptimisticRejectionKindView } from "./components/optimistic-rejection-kind-view";

export default {
  description:
    "Optimistic-rejection collector: drains the optimistic-mutation primitive's rejection sink (a write the server permanently refused — the optimistic op already dropped, or a detached write lost) into an error toast telling the user their edit was not saved, and a deduped report, plus the Debug → Reports summary view.",
  contributions: [
    Core.Root({ component: OptimisticRejectionCollector, scope: "page" }),
    Reports.KindView({
      match: "optimistic-rejection",
      component: OptimisticRejectionKindView,
    }),
  ],
} satisfies PluginDefinition;
