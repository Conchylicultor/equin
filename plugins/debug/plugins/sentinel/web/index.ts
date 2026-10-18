import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { Reports } from "@plugins/reports/web";
import { HealthReport } from "@plugins/shell/plugins/health-report/web";
import { SENTINEL_DOWN_KIND, sentinelConfig } from "../core";
import { DuressEpisodeSummary } from "./components/duress-episode-summary";
import { SentinelDownSummary } from "./components/sentinel-down-summary";
import { MachineWatcherDetail } from "./components/machine-watcher-detail";
import { MachineWatcherGlance } from "./components/machine-watcher-glance";
import { useMachineWatcherHealth } from "./internal/use-machine-watcher-health";

// Web presence: registers the sentinel config for Settings → Config, the
// duress-episode and sentinel-down report summaries for Debug → Reports, and the
// health report's Machine watcher row. The "cluster" trace section renders
// through the pane's GenericEventLane fallback for now; a dedicated Trace.Lane
// (load/pg/builds sparklines) is a follow-up.
export default {
  description:
    "Sentinel web presence: registers the sentinel config (sampler cadence + onset thresholds) for Settings → Config, the one-line duress-episode and sentinel-down report summaries for Debug → Reports, and the health report's Machine watcher row (critical while main's watcher is down or its process is gone or the disk is nearly full, attention while it restarts, the machine is under duress or the disk is low or filling fast, read from the sentinel.status push resource), with its stats — load per core, free memory, free disk and builds at a glance, and each signal that can trip duress against its limit when expanded — read from the sentinel.vitals push resource.",
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
    HealthReport.Row({
      kind: "status",
      id: "machine-watcher",
      title: "Machine watcher",
      // After Connection (10) and the server's own Database / Job queue (20):
      // this one is about the whole machine, not the server you are on.
      order: 30,
      useStatus: useMachineWatcherHealth,
      // Both read the per-tick vitals, and both mount only while the report is
      // open (the detail only while the row is expanded) — the summary above
      // never subscribes to them.
      glance: MachineWatcherGlance,
      component: MachineWatcherDetail,
    }),
  ],
} satisfies PluginDefinition;
