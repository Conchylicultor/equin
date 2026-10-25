import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { HealthReport } from "@plugins/shell/plugins/health-report/web";
import { RESOURCE_ERROR_KIND } from "../core";
import { ResourceErrorCollector } from "./components/resource-error-collector";
import { ResourceErrorKindView } from "./components/resource-error-kind-view";
import { useResourceErrorsHealth } from "./internal/use-resource-errors-health";

export default {
  description:
    "Resource-error collector: drains the live-state primitive's resourceErrorReportSink (one body per failing live read, however many hooks observe it) into a deduped resource-error report for the failures a developer must fix (loader-failed, not-found — never client-outdated or transport), the Debug → Reports summary view, and the health report's Live reads row (attention with 'N resources failing' while any read on the page is in error).",
  contributions: [
    Core.Root({ component: ResourceErrorCollector }),
    Reports.KindView({
      match: RESOURCE_ERROR_KIND,
      component: ResourceErrorKindView,
    }),
    HealthReport.Row({
      kind: "status",
      id: "live-reads",
      title: "Live reads",
      useStatus: useResourceErrorsHealth,
    }),
  ],
} satisfies PluginDefinition;
