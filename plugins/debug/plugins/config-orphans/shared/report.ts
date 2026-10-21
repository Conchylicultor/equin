import { liveValue } from "@plugins/network/plugins/live/core";
import { orphanReportSchema } from "@plugins/config_v2/core";

// Read-only audit of the current worktree's USER-layer config dir: every
// on-disk config file whose owning `defineConfig` descriptor is no longer live.
// The full report is one value (bounded — a few orphans at most). The dir is the
// desktop's (served by `machine/`): a reader under an in-browser server gets
// `unavailable`.
export const configOrphansReport = liveValue("config-orphans.report", {
  schema: orphanReportSchema,
  needsMachine: { feature: "Auditing saved settings on this machine" },
});
