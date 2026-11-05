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
  wedgedMs: number;
  supersededAtMs?: number;
  fleetState?: string;
  gatewayError?: string;
}

/**
 * What a boot that never became ready is NOW — or null when it is nothing to
 * report: it became ready, it exited (a crash, its own report), it is still
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
 * - `broken` — the gateway gave up on it and retries it only on a deploy or
 *   a browser start: **failed**, the worktree unusable.
 * - anything else (`idle`, `stopping`) — it runs nothing for the worktree and
 *   no longer holds the failure (a gateway restart, the idle sweeper); the
 *   next request boots it again: **killed**, a past fact.
 */
export function classifyNeverReady(
  ev: BootEvent,
  fleet: ReadonlyMap<string, FleetEntry> | null,
  now: number,
  budgetMs: number,
): WedgeVerdict | null {
  if (ev.readyAt !== null || ev.exitedAt !== null) return null;
  const wedgedMs = (ev.supersededAtMs ?? now) - ev.processStartedAt;
  if (wedgedMs < budgetMs) return null;
  if (ev.supersededAtMs !== null)
    return { state: "superseded", wedgedMs, supersededAtMs: ev.supersededAtMs };
  if (fleet === null) return null;
  const entry = fleet.get(ev.worktree);
  if (entry === undefined) return null;
  const base = {
    wedgedMs,
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
