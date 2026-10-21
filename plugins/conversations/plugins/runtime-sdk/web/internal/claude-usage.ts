import type { UsageWindowId } from "../../core";

// The usage limits' words, as the Claude Code row shows them.

export const USAGE_WINDOWS: Record<UsageWindowId, { label: string }> = {
  session: { label: "Session" },
  week: { label: "Week" },
};

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
