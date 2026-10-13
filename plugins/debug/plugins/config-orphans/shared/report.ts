import { liveValue } from "@plugins/network/plugins/live/core";
import { orphanReportSchema } from "@plugins/config_v2/core";

// Read-only audit of the current worktree's USER-layer config dir: every
// on-disk config file whose owning `defineConfig` descriptor is no longer live.
// The full report is one value (bounded — a few orphans at most); domain logic
// lives in config_v2, which owns config layout.
export const configOrphansReport = liveValue("config-orphans.report", {
  schema: orphanReportSchema,
});
