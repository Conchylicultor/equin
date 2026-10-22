import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { getConfig } from "@plugins/config_v2/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { readBootEvents } from "@plugins/debug/plugins/boot-events/server";
import { listWorktreeDirs } from "@plugins/infra/plugins/paths/server";
import { bootWatchdogConfig } from "../../core";
import { readFleet } from "./read-fleet";

// Per-process set of superseded wedges ALREADY filed. A superseded wedge is a
// closed, past outage: the boot channel keeps returning it every tick for as
// long as it sits inside the lookback window, so without a guard the watchdog
// would re-file the SAME dead outage each minute. Keying on `wt:processStartedAt`
// (the boot's identity) makes each superseded attempt file at most once per main
// process. Across a main restart the module reloads with a fresh Set, so a
// superseded wedge still inside the window re-files once — but collapses onto its
// stable fingerprint row (`boot-wedge:<worktree>`), bumping `count`. This is
// boot-budget's exact dedup pattern; OPEN wedges deliberately bypass it (see
// below) so the bell re-arms while the outage is still live.
const reportedSuperseded = new Set<string>();

// Main-only wedged-boot watchdog. Runs every minute in the MAIN backend only —
// NO perWorktree — because this is structurally impossible to do per-worktree: a
// perWorktree job dequeues only after its own backend booted successfully, so a
// backend can never observe its OWN wedged boot. Main reads every worktree's
// boot channel off the shared filesystem (readBootEvents — exactly how the
// timeline reads them) even while the owning backend is wedged, and files a
// deduped `boot-wedge` report for any boot that never reached its `ready` line
// within `bootReadyBudgetMs`.
//
// `dedup: "singleton"` + `maxAttempts: 3` mirror the other debug monitors.
// Silent when every recent boot came up within budget.
export const bootWatchdogMonitorJob = defineJob({
  name: "debug.boot-watchdog-monitor",
  description:
    "Files a report when a worktree's backend started but never became ready within its boot budget.",
  // seconds: one gateway fetch bounded by its own 2s AbortSignal.timeout, plus
  // a sweep of every worktree's boot channel off the shared filesystem.
  hold: "seconds",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "* * * * *" },
  maxAttempts: 3,
  run: async () => {
    const cfg = getConfig(bootWatchdogConfig);
    if (!cfg.enabled) return;

    const now = Date.now();
    // Read the gateway fleet ONCE per tick (null = unreadable this tick). Only
    // the OPEN branch consults it; a superseded wedge is a past fact needing no
    // liveness check.
    const fleet = await readFleet();

    for (const wt of listWorktreeDirs()) {
      for (const ev of readBootEvents(wt, cfg.lookbackMs)) {
        if (ev.readyAt !== null) continue; // became ready — not wedged
        // The wedge duration: to the superseding attempt's start (closed
        // outage) or to now (latest attempt, possibly wedged right now).
        const endMs = ev.supersededAtMs ?? now;
        const wedgedMs = endMs - ev.processStartedAt;
        if (wedgedMs < cfg.bootReadyBudgetMs) continue; // within budget — still booting, likely fine

        if (ev.supersededAtMs !== null) {
          // Superseded: the outage is over. File ONCE so it is on record.
          const key = `${wt}:${ev.processStartedAt}`;
          if (reportedSuperseded.has(key)) continue;
          reportedSuperseded.add(key);
          void recordReport({
            kind: "boot-wedge",
            source: "server-boot-watchdog",
            data: {
              worktree: wt,
              processStartedAt: ev.processStartedAt,
              wedgedMs,
              state: "superseded",
              supersededAtMs: ev.supersededAtMs,
              budgetMs: cfg.bootReadyBudgetMs,
            },
            message: `${wt} boot never became ready — un-ready ${Math.round(wedgedMs / 1000)}s, then superseded`,
          });
          continue;
        }

        // Open (latest attempt): distinguish wedged-NOW from torn-down. Only the
        // gateway fleet knows — presence (any state string) means the worktree
        // still exists and its backend is being run, so a missing ready line is a
        // live wedge. Absence means teardown → do not alert.
        if (fleet === null) continue; // gateway unreadable — skip open eval this tick
        if (!fleet.has(wt)) continue; // torn down, not wedged-now
        // Re-file each tick (NO dedup Set) so `count` ≈ minutes wedged and the
        // bell re-arms per the kind's cooldown.
        void recordReport({
          kind: "boot-wedge",
          source: "server-boot-watchdog",
          data: {
            worktree: wt,
            processStartedAt: ev.processStartedAt,
            wedgedMs,
            state: "open",
            budgetMs: cfg.bootReadyBudgetMs,
            fleetState: fleet.get(wt),
          },
          message: `${wt} backend wedged — un-ready ${Math.round(wedgedMs / 1000)}s and still live`,
        });
      }
    }
  },
});
