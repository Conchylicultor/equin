import type { UsageWindowId } from "../../core";

// The usage limits' words, as the Claude Code row shows them.

export const USAGE_WINDOWS: Record<
  UsageWindowId,
  {
    label: string;
    /** How long one window runs, reset to reset. */ lengthMs: number;
  }
> = {
  // Claude's `five_hour` and `seven_day` windows.
  session: { label: "Session", lengthMs: 5 * 60 * 60_000 },
  week: { label: "Week", lengthMs: 7 * 24 * 60 * 60_000 },
};

/**
 * How far through its window `now` is (0..1): where an even pace would put
 * the meter — the window started `lengthMs` before it resets.
 */
export function windowElapsed(
  id: UsageWindowId,
  resetsAt: number,
  now: number,
): number {
  const left = (resetsAt - now) / USAGE_WINDOWS[id].lengthMs;
  return Math.min(1, Math.max(0, 1 - left));
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
