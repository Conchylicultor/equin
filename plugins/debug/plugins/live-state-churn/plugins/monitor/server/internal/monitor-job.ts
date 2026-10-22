import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { getConfig } from "@plugins/config_v2/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { liveStateChurnConfig } from "../../core";
import { snapshot } from "./accumulator";

// Cheap scheduled live-state churn monitor. Runs every minute in EACH worktree's
// own backend (perWorktree) because the accumulator it reads is an in-process,
// per-backend memory store fed by that backend's own resource-runtime pushes.
// `dedup: "singleton"` means the monitor itself can never pile up, and
// `maxAttempts: 3` keeps a transiently-broken monitor from becoming a dead-job
// storm of its own. It reads the in-memory accumulator only — no DB query — and
// files reports only when a resource trips both the rate and minimum-sample
// thresholds (silent when healthy).
export const liveStateChurnMonitorJob = defineJob({
  name: "debug.live-state-churn-monitor",
  description:
    "Files a report when a live resource is pushed to clients at an abnormally high rate.",
  hold: "instant",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "* * * * *", perWorktree: true },
  maxAttempts: 3,
  run: async () => {
    const cfg = getConfig(liveStateChurnConfig);
    if (!cfg.enabled) return;

    const snap = snapshot(cfg.windowSeconds);
    for (const s of snap) {
      if (s.noopRate < cfg.noopRateThreshold) continue;
      if (s.noopCount < cfg.minNoopSamples) continue;

      await recordReport({
        kind: "live-state-noop",
        source: "server-live-state-monitor",
        data: {
          resourceKey: s.resourceKey,
          noopRate: s.noopRate,
          noopCount: s.noopCount,
          totalCount: s.totalCount,
          subscribers: s.subscribers,
          windowSeconds: cfg.windowSeconds,
        },
        message: `${s.resourceKey}: ~${s.noopRate.toFixed(1)} no-op pushes/s (×${s.noopCount}/${cfg.windowSeconds}s)`,
      });
    }
  },
});
