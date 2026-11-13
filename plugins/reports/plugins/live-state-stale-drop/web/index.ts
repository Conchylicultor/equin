import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { httpStaleDropReportSink } from "@plugins/network/plugins/live/plugins/live-state/web";
import { drain } from "@plugins/primitives/plugins/report-sink/web";
import { ReportSinks } from "@plugins/reports/plugins/collectors/web";
import { collectStaleDrop } from "./internal/live-state-stale-drop-collector";
import { LiveStateStaleDropKindView } from "./components/live-state-stale-drop-kind-view";

export default {
  description:
    "Live-state stale-drop collector: drains the live-state primitive's httpStaleDropReportSink into a deduped report when a resource wedges on a stale HTTP body (3 consecutive drops, never applied — the 'Close (state unknown)' bug), plus the Debug → Reports summary view.",
  contributions: [
    ReportSinks.Collector({
      from: "network.live.live-state",
      collect: drain(httpStaleDropReportSink, collectStaleDrop),
      companion: true,
    }),
    Reports.KindView({
      match: "live-state-stale-drop",
      component: LiveStateStaleDropKindView,
    }),
  ],
} satisfies PluginDefinition;
