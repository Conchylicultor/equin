import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Core } from "@plugins/framework/plugins/web-sdk/core";
import { wedgeReportSink } from "@plugins/infra/plugins/health/web";
import { resizeLoopReportSink } from "@plugins/primitives/plugins/dom/plugins/element-size/plugins/resize-loop-trace/web";
import { boundaryReportSink } from "@plugins/primitives/plugins/error-boundary/web";
import { requestGuardReportSink } from "@plugins/primitives/plugins/networking/plugins/request-guard/web";
import { drain } from "@plugins/primitives/plugins/report-sink/web";
import { ReportSinks } from "@plugins/reports/plugins/collectors/web";
import { Reports } from "@plugins/reports/web";
import { CrashCollector } from "./components/crash-collector";
import { CrashSummary } from "./components/crash-summary";
import {
  collectBoundaryCrash,
  collectRequestGuardCrash,
  collectResizeLoopCrash,
  collectWedgeCrash,
} from "./internal/crash-sinks";

export default {
  collapsed: true,
  description:
    "Crash report kind: browser crash collector and the Debug → Reports summary view.",
  contributions: [
    Core.Root({ component: CrashCollector, scope: "page" }),
    ReportSinks.Collector({
      from: "primitives.error-boundary",
      collect: drain(boundaryReportSink, collectBoundaryCrash),
      companion: true,
    }),
    ReportSinks.Collector({
      from: "infra.health",
      collect: drain(wedgeReportSink, collectWedgeCrash),
      companion: true,
    }),
    ReportSinks.Collector({
      from: "primitives.networking.request-guard",
      collect: drain(requestGuardReportSink, collectRequestGuardCrash),
      companion: true,
    }),
    ReportSinks.Collector({
      from: "primitives.dom.element-size.resize-loop-trace",
      collect: drain(resizeLoopReportSink, collectResizeLoopCrash),
      companion: true,
    }),
    Reports.KindView({ match: "crash", component: CrashSummary }),
  ],
} satisfies PluginDefinition;
