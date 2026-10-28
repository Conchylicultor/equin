import type { ClaudeUsage, ClaudeUsageWindow } from "./claude-usage";

// How full an account's limits are now, from its last report — shared by the
// health row (meters, the account picker) and the launch (auto-switch).

export type UsageWindowId = "session" | "week";

export type UsageLevel = "ok" | "high" | "full";

/**
 * One window as read now:
 * - `current` — its last reading still covers now: how full (0..1).
 * - `reset` — it reset after the last reading, and no agent has run since:
 *   how full it is now is not known (but it restarted from empty).
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

/**
 * The window whose limit is reached now, the one resetting last first (that is
 * when agents can run again), or `null` — also for an account no agent has
 * reported on (`undefined`).
 */
export function limitReached(
  usage: ClaudeUsage | undefined,
  now: number,
): { id: UsageWindowId; resetsAt: number } | null {
  if (!usage) return null;
  let reached: { id: UsageWindowId; resetsAt: number } | null = null;
  for (const id of ["session", "week"] as const) {
    const w = usage[id];
    if (!w) continue;
    const view = viewUsageWindow(w, now);
    if (view.kind !== "current" || view.level !== "full") continue;
    if (!reached || view.resetsAt > reached.resetsAt) {
      reached = { id, resetsAt: view.resetsAt };
    }
  }
  return reached;
}

/**
 * How much of its weekly limit an account has left (0..1) — what accounts are
 * compared by: the 5-hour session resets too often to choose an account by.
 * `unknown` while no agent has reported a week for it.
 */
export type WeekRoom = { kind: "known"; left: number } | { kind: "unknown" };

export function weekRoom(
  usage: ClaudeUsage | undefined,
  now: number,
): WeekRoom {
  if (!usage?.week) return { kind: "unknown" };
  const view = viewUsageWindow(usage.week, now);
  return {
    kind: "known",
    left: view.kind === "reset" ? 1 : Math.max(0, 1 - view.utilization),
  };
}

/**
 * An account as a launch weighs it. `metered`: billed per use (an API key) —
 * it has no plan limits, so nothing ever says it is full; it is the overflow.
 */
export interface LaunchCandidate {
  id: string;
  metered: boolean;
}

/**
 * The account with the most weekly room among `candidates`, skipping any whose
 * limit is reached now; an account never reported on ranks after every known
 * one. A metered account only when no plan account can run. `null` when none
 * can run.
 */
export function roomiestAccount(
  candidates: readonly LaunchCandidate[],
  byAccount: Readonly<Record<string, ClaudeUsage>>,
  now: number,
): string | null {
  let best: { id: string; left: number } | null = null;
  for (const { id } of candidates.filter((c) => !c.metered)) {
    const usage = byAccount[id];
    if (limitReached(usage, now)) continue;
    const room = weekRoom(usage, now);
    // Unknown ranks below known-empty: a reported 0% left still ran out.
    const left = room.kind === "known" ? room.left : -1;
    if (!best || left > best.left) best = { id, left };
  }
  return best?.id ?? candidates.find((c) => c.metered)?.id ?? null;
}

/**
 * The account an agent launches on: the active one — unless auto-switch is
 * on and either its limit is reached (then the roomiest other one that can
 * run, or the active one still, when none can) or it is metered (then back to
 * the roomiest plan account that can run: the overflow is left as soon as a
 * plan has room, or it would become the active one and drain).
 */
export function launchAccount(opts: {
  accounts: readonly LaunchCandidate[];
  active: string;
  autoSwitch: boolean;
  byAccount: Readonly<Record<string, ClaudeUsage>>;
  now: number;
}): string {
  const { accounts, active, autoSwitch, byAccount, now } = opts;
  if (!autoSwitch) return active;
  if (accounts.find((a) => a.id === active)?.metered) {
    return (
      roomiestAccount(
        accounts.filter((a) => !a.metered),
        byAccount,
        now,
      ) ?? active
    );
  }
  if (!limitReached(byAccount[active], now)) return active;
  return (
    roomiestAccount(
      accounts.filter((a) => a.id !== active),
      byAccount,
      now,
    ) ?? active
  );
}
