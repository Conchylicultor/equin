import { Core, type PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { LiveStateStaleDropCollector } from "./components/live-state-stale-drop-collector";
import { LiveStateStaleDropKindView } from "./components/live-state-stale-drop-kind-view";

export default {
  description:
    "Live-state stale-drop collector: drains the live-state primitive's httpStaleDropReportSink into a deduped report when a resource wedges on a stale HTTP body (3 consecutive drops, never applied — the 'Close (state unknown)' bug), plus the Debug → Reports summary view.",
  contributions: [
    Core.Root({ component: LiveStateStaleDropCollector, scope: "page" }),
    Reports.KindView({
      match: "live-state-stale-drop",
      component: LiveStateStaleDropKindView,
    }),
  ],
} satisfies PluginDefinition;
