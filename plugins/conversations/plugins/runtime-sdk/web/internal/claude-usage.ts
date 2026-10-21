import type { ClaudeUsageRead, ClaudeUsageWindow } from "../../core";

// The subscription's usage limits as the Claude Code row shows them.

export type UsageWindowId = "session" | "week";

export const USAGE_WINDOWS: Record<UsageWindowId, { label: string }> = {
  session: { label: "Session" },
  week: { label: "Week" },
};

export type UsageLevel = "ok" | "high" | "full";

/**
 * One window as read now:
 * - `current` — its last reading still covers now: how full (0..1).
 * - `reset` — it reset after the last reading, and no agent has run since:
 *   how full it is now is not known.
 */
export type UsageWindowView =
  | {
      kind: "current";
      utilization: number;
      level: UsageLevel;
      resetsAt: number;
    }
  | { kind: "reset"; resetAt: number };

export function usageLevel(utilization: number): UsageLevel {
  if (utilization >= 1) return "full";
  if (utilization >= 0.8) return "high";
  return "ok";
}

export function viewUsageWindow(
  w: ClaudeUsageWindow,
  now: number,
): UsageWindowView {
  if (w.resetsAt <= now) return { kind: "reset", resetAt: w.resetsAt };
  return {
    kind: "current",
    utilization: w.utilization,
    level: usageLevel(w.utilization),
    resetsAt: w.resetsAt,
  };
}

/** `in 1 h 48 m` / `in 12 m` — for the session, which resets within hours. */
export function formatResetsIn(resetsAt: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((resetsAt - now) / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `in ${m} m`;
  return m === 0 ? `in ${h} h` : `in ${h} h ${m} m`;
}

/** `Thu 09:00` — for the week, which resets on a day. */
export function formatResetsOn(resetsAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(resetsAt);
}

export function formatResets(
  id: UsageWindowId,
  resetsAt: number,
  now: number,
): string {
  return id === "session"
    ? `resets ${formatResetsIn(resetsAt, now)}`
    : `resets ${formatResetsOn(resetsAt)}`;
}

/**
 * The window whose limit is reached now, the one resetting last first (that is
 * when agents can run again), or `null`.
 */
export function limitReached(
  read: ClaudeUsageRead,
  now: number,
): { id: UsageWindowId; resetsAt: number } | null {
  if (read.kind === "none") return null;
  let reached: { id: UsageWindowId; resetsAt: number } | null = null;
  for (const id of ["session", "week"] as const) {
    const w = read.usage[id];
    if (!w) continue;
    const view = viewUsageWindow(w, now);
    if (view.kind !== "current" || view.level !== "full") continue;
    if (!reached || view.resetsAt > reached.resetsAt) {
      reached = { id, resetsAt: view.resetsAt };
    }
  }
  return reached;
}
