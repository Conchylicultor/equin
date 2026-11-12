import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { Reports } from "@plugins/reports/web";
import { SENTINEL_DOWN_KIND, sentinelConfig } from "../core";
import { DuressEpisodeSummary } from "./components/duress-episode-summary";
import { SentinelDownSummary } from "./components/sentinel-down-summary";

// Web presence: registers the sentinel config for Settings → Config, the
// duress-episode and sentinel-down report summaries for Debug → Reports. The
// health report's Machine watcher row is the health-row sub-plugin's. The "cluster" trace section renders
// through the pane's GenericEventLane fallback for now; a dedicated Trace.Lane
// (load/pg/builds sparklines) is a follow-up.
export default {
  description:
    "Sentinel web presence: registers the sentinel config (sampler cadence + onset thresholds) for Settings → Config and the one-line duress-episode and sentinel-down report summaries for Debug → Reports. The health report's Machine watcher row is its health-row sub-plugin.",
  contributions: [
    ConfigV2.WebRegister({ descriptor: sentinelConfig }),
    Reports.KindView({
      match: "duress-episode",
      component: DuressEpisodeSummary,
    }),
    Reports.KindView({
      match: SENTINEL_DOWN_KIND,
      component: SentinelDownSummary,
    }),
  ],
} satisfies PluginDefinition;
