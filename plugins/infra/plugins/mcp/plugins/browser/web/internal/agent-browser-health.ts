import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import type { AgentBrowserStatus } from "../../core";

/** How recent a host error must be to put the row in attention (and show). */
export const RECENT_ERROR_MS = 10 * 60_000;

/** A session this close to its idle close is flagged (it is about to go). */
const CLOSES_SOON_MS = 2 * 60_000;

/** `4 min` / `30 s` / `now` — the time left until a deadline, from `now`. */
export function durationText(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return "now";
  if (ms < 60_000) return `${Math.ceil(ms / 1000)} s`;
  return `${Math.ceil(ms / 60_000)} min`;
}

/** `in 4 min` / `in 30 s` / `now` — a deadline, from `now`. */
export function untilText(iso: string, now: number): string {
  const left = durationText(iso, now);
  return left === "now" ? left : `in ${left}`;
}

/** Whether a session's idle close is near enough to flag. */
export function closesSoon(iso: string, now: number): boolean {
  return Date.parse(iso) - now < CLOSES_SOON_MS;
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/**
 * The Agent browser row's verdict.
 *
 * - loading → `unknown` ("Checking…"), never `ok`;
 * - no host (never launched, or exited) → `ok`: it starts on the first call;
 * - running → `ok` with its session count (and calls queued for a
 *   browser slot), or `attention` while a failure it hit on its own (an idle
 *   close, a revert, a write drain that timed out) is recent;
 * - a status naming a dead pid → `attention`: the host died without closing
 *   its sessions (the next call relaunches it and reverts their writes);
 * - unreadable → `unknown` with why.
 */
export function agentBrowserVerdict(
  result: ResourceResult<AgentBrowserStatus>,
  now: number,
): HealthStatus {
  if (result.status === "loading") return { state: "unknown" };
  if (result.status === "error") {
    return {
      state: "unknown",
      summary: "Couldn't load the agent browser's status",
    };
  }
  const s = result.data;
  switch (s.kind) {
    case "absent":
      return {
        state: "ok",
        summary: "Not running — starts on an agent's first browser_* call",
      };
    case "exited":
      return {
        state: "ok",
        summary: `Not running (exited: ${s.host.exitReason ?? "no reason"}) — starts on the next browser_* call`,
      };
    case "died":
      return {
        state: "attention",
        summary: `Host (pid ${s.host.pid}) died without closing its ${plural(s.host.sessions.length, "session")} — the next browser_* call restarts it`,
      };
    case "unreadable":
      return {
        state: "unknown",
        summary: `Status file unreadable: ${s.reason}`,
      };
    case "running": {
      const { sessions, errors, idleExitAt, drives } = s.host;
      const recent = errors.filter(
        (e) => now - Date.parse(e.at) < RECENT_ERROR_MS,
      );
      const last = recent.at(-1);
      if (last) {
        return {
          state: "attention",
          summary: `${last.during} failed: ${last.message.split("\n", 1)[0]}`,
        };
      }
      if (sessions.length === 0) {
        return {
          state: "ok",
          summary: `Idle — exits ${idleExitAt === null ? "soon" : untilText(idleExitAt, now)}`,
        };
      }
      const queued =
        drives.waiting === 0
          ? ""
          : ` · ${plural(drives.waiting, "call")} waiting for a browser slot`;
      return {
        state: "ok",
        summary: `${plural(sessions.length, "session")}${queued}`,
      };
    }
  }
}
