import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { getConfig } from "@plugins/config_v2/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import {
  readBootEvents,
  readBootJournals,
} from "@plugins/debug/plugins/boot-events/server";
import {
  clearBootUnsettled,
  markBootUnsettled,
  readBootUnsettled,
  stampBootUnsettledIndexed,
} from "@plugins/debug/plugins/boot-events/machine";
import {
  bootWatchdogConfig,
  describeBootWedge,
  type BootWedgePayload,
} from "../../core";
import { classifyNeverReady } from "./classify-wedge";
import { readFleet } from "./read-fleet";
import { listWorktreeDirs } from "@plugins/infra/plugins/paths/server";
import type { BootEvent } from "@plugins/debug/plugins/boot-events/server";

// Per-process set of closed wedges (superseded, restart-failed, killed)
// ALREADY filed. A closed wedge is a past fact: the boot channel keeps returning it every tick for as
// long as it sits inside the lookback window, so without a guard the watchdog
// would re-file the SAME dead outage each minute. Keying on `wt:processStartedAt`
// (the boot's identity) makes each superseded attempt file at most once per main
// process. Across a main restart the module reloads with a fresh Set, so a
// superseded wedge still inside the window re-files once — but collapses onto its
// stable fingerprint row (`boot-wedge:<worktree>`), bumping `count`. This is
// boot-budget's exact dedup pattern; booting / failed wedges deliberately bypass
// it (see below) so the bell re-arms while the worktree is still unusable.
const reportedOnce = new Set<string>();

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
      ...[...fleet]
        .filter(([, entry]) => entry.state !== "idle")
        .map(([wt]) => wt),
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
      // The journal only for a worktree with a never-ready boot to describe
      // (it is ~100 lines a boot).
      let journals: ReturnType<typeof readBootJournals> | null = null;
      for (const ev of events) {
        // A boot that exited before ready is a crash, not a wedge: its own
        // report — boot-events files it, error and stack, through the report
        // outbox — and measured to the next start its "un-ready" time would be
        // however long the agent took to rebuild (classifyNeverReady skips it).
        const verdict = classifyNeverReady(
          ev,
          fleet,
          now,
          cfg.bootReadyBudgetMs,
        );
        if (verdict === null) continue;
        // Superseded, restart-failed and killed are closed facts (a later
        // boot replaced it; the old backend kept serving; the gateway no
        // longer holds the failure and boots it on the next request): filed
        // ONCE. Booting and failed are true NOW — the worktree has no ready
        // backend — so they are re-filed each tick (NO dedup Set): `count` ≈
        // minutes unusable, and the bell re-arms per the kind's cooldown.
        if (
          verdict.state === "superseded" ||
          verdict.state === "restart-failed" ||
          verdict.state === "killed"
        ) {
          const key = `${wt}:${ev.processStartedAt}`;
          if (reportedOnce.has(key)) continue;
          reportedOnce.add(key);
        }
        journals ??= readBootJournals(wt);
        const journal = journals.get(ev.processStartedAt);
        const data: BootWedgePayload = {
          worktree: wt,
          processStartedAt: ev.processStartedAt,
          budgetMs: cfg.bootReadyBudgetMs,
          ...verdict,
          ...(journal && {
            journal: {
              lastEntryAtMs: journal.lastEntryAtMs,
              importedAtMs: journal.importedAtMs,
              diedIn: journal.diedIn?.id ?? null,
              slowest: journal.slowest,
              darwinbgMs: journal.darwinbgMs,
            },
          }),
        };
        void recordReport({
          kind: "boot-wedge",
          source: "server-boot-watchdog",
          data,
          message: describeBootWedge(data),
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
