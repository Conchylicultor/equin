import { liveValue } from "@plugins/network/plugins/live/core";
import { HealthDataSchema } from "../core";

/**
 * The Health pane's read: every worktree's health series and the host samples
 * over the last 2 h, read from the per-worktree JSONL on disk (so a wedged
 * backend's history still shows). Pushed after each of this backend's own
 * sampler ticks (every 10 s), which re-read every file.
 */
export const healthMonitorSeries = liveValue("health-monitor.series", {
  schema: HealthDataSchema,
});
