import type { BootEvent } from "@plugins/debug/plugins/boot-events/server";
import type { BootWedgeState } from "../../core";

/** One worktree as the gateway lists it (`GET /gateway/worktrees`). */
export interface FleetEntry {
  state: string;
  /** Its last failed start, "" when none. */
  lastSpawnErr: string;
}

export interface WedgeVerdict {
  state: Exclude<BootWedgeState, "open">;
  /** Un-ready AWAKE time: the wall span less the sleep inside it. */
  wedgedMs: number;
  /** The machine's sleep inside the span, when it slept (> 0). */
  sleptMs?: number;
  supersededAtMs?: number;
  fleetState?: string;
  gatewayError?: string;
}

/**
 * What a boot that never became ready is NOW — or null when it is nothing to
 * report: it became ready, it exited (a crash, its own report), it is
 * already settled dead (`deadBy`: this watchdog reported it), it is still
 * within its budget, the gateway is unreadable this tick (`fleet` null: not
 * guessed), or the worktree is gone from the fleet (torn down).
 *
 * The gateway is the only witness of whether the process still runs: a boot
 * it killed at its readiness deadline (a SIGKILL) writes no exit line, so its
 * journal alone reads exactly like a live wedge — the old "still live" report
 * of a process dead for 31 h. Its fleet state decides:
 *
 * - `starting` / `restarting` — it is still waiting on a boot: **booting**.
 * - `running` — a backend serves, so the never-ready boot was a hot restart's
 *   new process, killed while the old one kept serving: **restart-failed**.
 * - `broken` — the gateway gave up on it (killed it) and retries it only on a
 *   deploy or a browser start: **failed**, the worktree unusable until then.
 * - anything else (`idle`, `stopping`) — it runs nothing for the worktree and
 *   no longer holds the failure (a gateway restart, the idle sweeper); the
 *   next request boots it again: **killed**, a past fact.
 */
export function classifyNeverReady(
  ev: BootEvent,
  fleet: ReadonlyMap<string, FleetEntry> | null,
  now: number,
  budgetMs: number,
  sleptDuring: (startMs: number, endMs: number) => number,
): WedgeVerdict | null {
  if (ev.readyAt !== null || ev.exitedAt !== null || ev.deadBy !== null)
    return null;
  // The budget is spent by AWAKE time only. A nap freezes the booting process
  // and every clock it reads alike (its journal's ms pause too), so a boot
  // the Mac slept through is no slower for it: 2026-11-20 a backend started
  // the second a lid-shut Mac entered a 934 s maintenance sleep, and the
  // first tick on wake filed it "not ready after 16m … in load:wave-24 at
  // 1s" — it was ready 1.6 s later, having run ~3 s in all.
  const endMs = ev.supersededAtMs ?? now;
  const sleptMs = Math.max(0, sleptDuring(ev.processStartedAt, endMs));
  const wedgedMs = endMs - ev.processStartedAt - sleptMs;
  if (wedgedMs < budgetMs) return null;
  const slept = sleptMs > 0 ? { sleptMs } : {};
  if (ev.supersededAtMs !== null)
    return {
      state: "superseded",
      wedgedMs,
      ...slept,
      supersededAtMs: ev.supersededAtMs,
    };
  if (fleet === null) return null;
  const entry = fleet.get(ev.worktree);
  if (entry === undefined) return null;
  const base = {
    wedgedMs,
    ...slept,
    fleetState: entry.state,
    ...(entry.lastSpawnErr !== "" && { gatewayError: entry.lastSpawnErr }),
  };
  switch (entry.state) {
    case "starting":
    case "restarting":
      return { state: "booting", ...base };
    case "running":
      return { state: "restart-failed", ...base };
    case "broken":
      return { state: "failed", ...base };
    default:
      return { state: "killed", ...base };
  }
}

/**
 * Whether the boot's process is known gone — every verdict but `booting`. A
 * boot the gateway is still waiting on may yet become ready; any other one
 * was killed (at its readiness deadline, or replaced by a later boot) and its
 * report is a fact about a past boot: filed once, and the boot settled with a
 * `dead` line so nothing reads it as open again — not after a main restart
 * either. A new boot of the same worktree is a new boot, with its own report.
 */
export function isSettledVerdict(verdict: WedgeVerdict): boolean {
  return verdict.state !== "booting";
}
