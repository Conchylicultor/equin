import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { getConfig } from "@plugins/config_v2/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { readBootEvents } from "@plugins/debug/plugins/boot-events/server";
import {
  clearBootUnsettled,
  markBootUnsettled,
  readBootUnsettled,
  stampBootUnsettledIndexed,
} from "@plugins/debug/plugins/boot-events/machine";
import { bootWatchdogConfig } from "../../core";
import { readFleet } from "./read-fleet";
import { listWorktreeDirs } from "@plugins/infra/plugins/paths/server";
import type { BootEvent } from "@plugins/debug/plugins/boot-events/server";

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
    // Read the gateway fleet ONCE per tick (null = unreadable this tick).
    const fleet = await readFleet();
    // Unreadable fleet ⇒ no sweep this tick: it is the only source of which
    // worktrees exist and which have a backend. Both wedge kinds stay
    // fileable on the next readable tick (an open one stays open; a
    // superseded one stays inside the lookback window).
    if (fleet === null) return;

    // WHICH worktrees to read — the ones that can hold a wedge, not every
    // worktree dir (~240–300 synchronous `boot.jsonl` tail reads on main's
    // event loop each minute: 4–7 s stalls under host load, to evaluate ~10):
    //
    //  • every worktree the gateway runs a backend for — any state but `idle`
    //    (starting / running / restarting / stopping / broken). A boot that
    //    never becomes ready is born here: `starting`, then `broken` when the
    //    gateway abandons it at its readiness deadline, which lasts until the
    //    next spawn. A superseding boot is itself a backend, so a superseded
    //    wedge is read here too.
    //  • every worktree MARKED unsettled (boot-events' marks): a backend marks
    //    its worktree right after its `start` line, and only this sweep clears
    //    the mark, once it has read that worktree's boot as settled (ready or
    //    exited). So a never-ready worktree the gateway lists `idle` (after a
    //    gateway restart, a stop, a kill) is still read every tick and still
    //    filed as open while it stays unusable — whatever the timing.
    //
    // Marks are complete once stamped `indexed`; until then (first run, or the
    // dir was deleted) one full sweep marks every worktree with an open boot.
    let marks = await readBootUnsettled();
    if (!marks.indexed) {
      for (const wt of listWorktreeDirs()) {
        if (hasUnsettledBoot(readBootEvents(wt, cfg.lookbackMs)))
          markBootUnsettled(wt);
      }
      stampBootUnsettledIndexed();
      marks = await readBootUnsettled();
    }
    const sweep = new Set([
      ...[...fleet].filter(([, state]) => state !== "idle").map(([wt]) => wt),
      ...marks.worktrees,
    ]);

    for (const wt of sweep) {
      const events = readBootEvents(wt, cfg.lookbackMs);
      // Open ⇒ marked, whoever wrote its start line (a backend whose code
      // predates the marks): from here on it is read every tick, idle or not,
      // until it settles. Settled ⇒ the mark is cleared, unless it is newer
      // than the settling (a boot started since). A mark is never cleared
      // while its boot is open — out of the fleet included (a worktree the
      // gateway drops and re-adds is still read).
      if (hasUnsettledBoot(events)) {
        if (!marks.worktrees.includes(wt)) markBootUnsettled(wt);
      } else if (marks.worktrees.includes(wt)) {
        await clearBootUnsettled(wt, settledAtMs(events, cfg.lookbackMs, now));
      }
      if (!fleet.has(wt)) continue; // torn down: never alerted
      for (const ev of events) {
        if (ev.readyAt !== null) continue; // became ready — not wedged
        // Exited before ready: a boot crash, not a wedge. The crash is its
        // own report — boot-events files it, error and stack, through the
        // report outbox — and measured to the next start its "un-ready" time
        // would be however long the agent took to rebuild.
        if (ev.exitedAt !== null) continue;
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

        // Open (latest attempt) on a worktree the gateway still lists — any
        // state, `idle` included: present means the worktree exists and is
        // unusable until a boot becomes ready.
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

/** The worktree's latest boot neither became ready nor exited (open). */
function hasUnsettledBoot(events: readonly BootEvent[]): boolean {
  return events.some(
    (e) =>
      e.readyAt === null && e.exitedAt === null && e.supersededAtMs === null,
  );
}

/**
 * When the worktree's latest boot settled (its ready or exit time). No boot in
 * the lookback window: nothing settled inside it, so a mark older than the
 * window's start is a leftover (a worktree whose boot.jsonl is gone, or
 * quiet) and a newer one may still have its `start` line coming.
 */
function settledAtMs(
  events: readonly BootEvent[],
  lookbackMs: number,
  now: number,
): number {
  let latest = now - lookbackMs;
  for (const e of events) {
    const at = e.readyAt ?? e.exitedAt;
    if (at !== null && at > latest) latest = at;
  }
  return latest;
}
