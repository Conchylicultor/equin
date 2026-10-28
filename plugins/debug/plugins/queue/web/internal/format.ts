/** A coarse span (`12s`, `4m`, `3h`, `2d`) for "in …" / "… ago". */
function span(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * When an instant falls relative to `now`, either way: `in 3m` for the future,
 * `12s ago` / `just now` for the past. (`RelativeTime` reads only the past —
 * a pending job's run-at is usually ahead of now.)
 */
export function formatWhen(date: Date, now: number): string {
  const delta = date.getTime() - now;
  if (delta > 1000) return `in ${span(delta)}`;
  if (-delta < 5000) return "just now";
  return `${span(delta)} ago`;
}

/** An absolute timestamp, to the second, in the viewer's locale. */
export function formatAbsolute(date: Date): string {
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** The first line of a (possibly multi-line) error, for a one-line cell. */
export function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0] ?? "";
}

/** A compact one-line JSON rendering (a payload / job input preview). */
export function compactJson(value: unknown): string {
  return JSON.stringify(value) ?? "";
}
