import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { getConfig } from "@plugins/config_v2/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import {
  CLIMB_CURVE_MS,
  TAB_MEMORY_CLIMB_KIND,
  tabMemoryClimbConfig,
} from "../../core";
import { detectClimbs } from "./detect";
import { readOwnerSamples, readPageLogs } from "./read";
import { pagesFrom } from "./reduce";

/**
 * The climb watch: every 10 minutes, on main only (the owner sampler runs on
 * main and the page logs of every worktree are read from there), judges each
 * Chrome renderer's memory floor and files a `tab-memory-climb` report per
 * renderer past the bar. A scheduled job, not a watcher: the climbs it names
 * last hours, and the readings it judges arrive every 30 s, so a recompute
 * per append would be all cost. Silent while every renderer is within bounds.
 */
export const tabMemoryClimbJob = defineJob({
  name: "debug.tab-memory-climb",
  description:
    "Files a report when a Chrome tab's memory is too large or keeps climbing, with the pages it held.",
  // Reads main's owner log and every worktree's page log, one file at a time.
  hold: "seconds",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "*/10 * * * *" },
  maxAttempts: 3,
  run: async () => {
    const cfg = getConfig(tabMemoryClimbConfig);
    if (!cfg.enabled) return;
    const now = Date.now();
    const owners = await readOwnerSamples(now - CLIMB_CURVE_MS);
    const pages = pagesFrom(await readPageLogs(now - CLIMB_CURVE_MS));
    const climbs = detectClimbs(owners, pages, now, {
      highFloorMb: cfg.highFloorMb,
      climbFloorMb: cfg.climbFloorMb,
      climbRiseMb: cfg.climbRiseMb,
    });
    for (const c of climbs)
      await recordReport({
        kind: TAB_MEMORY_CLIMB_KIND,
        source: "server-tab-memory-monitor",
        data: c,
        message:
          c.trigger === "climbing"
            ? `Chrome renderer ${c.pid} climbing: floor ${c.floorNowMb} MB, +${c.riseMb} MB at ${c.riseMbPerHour} MB/h (${c.growth})`
            : `Chrome renderer ${c.pid} too large: floor ${c.floorNowMb} MB (${c.growth})`,
      });
  },
});
