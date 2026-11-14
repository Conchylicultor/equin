import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { getConfig } from "@plugins/config_v2/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { describeNoopWaste, liveStateChurnConfig } from "../../core";
import { snapshot, type KeySnapshot } from "./accumulator";
import type { LiveStateNoopPayload } from "../../core";

/**
 * The report one key's window files, or `null` when its no-op recomputes waste
 * less work per minute than the bar — the monitor's whole decision.
 */
export function noopReportData(
  s: KeySnapshot,
  cfg: { wastedMsPerMinuteThreshold: number; windowSeconds: number },
): LiveStateNoopPayload | null {
  // No no-op, nothing wasted — whatever the bar (it may be set to 0).
  if (s.noopCount === 0) return null;
  if (s.wastedMsPerMinute < cfg.wastedMsPerMinuteThreshold) return null;
  return {
    resourceKey: s.resourceKey,
    noopRate: s.noopRate,
    noopCount: s.noopCount,
    totalCount: s.totalCount,
    subscribers: s.subscribers,
    windowSeconds: cfg.windowSeconds,
    wastedMsPerMinute: s.wastedMsPerMinute,
    wastedOwnMs: s.noopOwnMs,
    wastedIoMs: s.noopIoMs,
    wastedWaitMs: s.noopWaitMs,
  };
}

// Cheap scheduled live-state churn monitor. Runs every minute in EACH worktree's
// own backend (perWorktree) because the accumulator it reads is an in-process,
// per-backend memory store fed by that backend's own resource-runtime pushes.
// `dedup: "singleton"` means the monitor itself can never pile up, and
// `maxAttempts: 3` keeps a transiently-broken monitor from becoming a dead-job
// storm of its own. It reads the in-memory accumulator only — no DB query.
//
// A resource files when its no-op recomputes WASTE material work — own work
// plus io, per minute (see `liveStateChurnConfig`) — not when they are merely
// frequent: a cheap recompute churning at 3/s costs a fraction of a percent of
// a core, while an expensive one is worth a report at one a minute. A no-op
// whose cost the host did not measure (a host without the profiler) is never
// judged — the report would have nothing to say about what it costs.
export const liveStateChurnMonitorJob = defineJob({
  name: "debug.live-state-churn-monitor",
  description:
    "Files a report when a live resource's identical (no-op) recomputes waste a material amount of server work.",
  hold: "instant",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "* * * * *", perWorktree: true },
  maxAttempts: 3,
  run: async () => {
    const cfg = getConfig(liveStateChurnConfig);
    if (!cfg.enabled) return;

    for (const s of snapshot(cfg.windowSeconds)) {
      const data = noopReportData(s, cfg);
      if (data === null) continue;
      await recordReport({
        kind: "live-state-noop",
        source: "server-live-state-monitor",
        data,
        message: `${s.resourceKey}: ${describeNoopWaste(data)}`,
      });
    }
  },
});
