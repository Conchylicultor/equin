const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * A span of milliseconds as a person reads it at a glance — the duration
 * type's one spelling, so every list draws a span the same way:
 * `0.4ms` / `850ms` under a second, `4.2s` under a minute, then `1m 04s`,
 * `2h 05m`, `3d 04h`. Negative spans keep their sign.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms))
    throw new Error(`formatDuration: ${ms} is not a span`);
  if (ms < 0) return `-${formatDuration(-ms)}`;
  if (ms < 10 && Math.round(ms * 10) < 100) {
    const tenths = Math.round(ms * 10) / 10;
    return `${Number.isInteger(tenths) ? tenths : tenths.toFixed(1)}ms`;
  }
  if (Math.round(ms) < SECOND) return `${Math.round(ms)}ms`;
  const tenthsOfSecond = Math.round(ms / 100);
  if (tenthsOfSecond < 600) return `${(tenthsOfSecond / 10).toFixed(1)}s`;
  const s = Math.round(ms / SECOND);
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad2(s % 60)}s`;
  const m = Math.round(ms / MINUTE);
  if (m < 24 * 60) return `${Math.floor(m / 60)}h ${pad2(m % 60)}m`;
  const h = Math.round(ms / HOUR);
  return `${Math.floor(h / 24)}d ${pad2(h % 24)}h`;
}

const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: SECOND,
  sec: SECOND,
  m: MINUTE,
  min: MINUTE,
  h: HOUR,
  hr: HOUR,
  d: DAY,
};

const TERM = /(\d+(?:\.\d+)?|\.\d+)\s*([a-z]*)/gy;

/**
 * A span typed by a person → its milliseconds: `250ms`, `30s`, `5m`, `1.5h`,
 * `2d`, a sum of terms (`1m 30s`, `1h30m`), or a bare number (milliseconds).
 * `null` when the text is not a span.
 */
export function parseDuration(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (text === "") return null;
  let total = 0;
  let at = 0;
  let terms = 0;
  while (at < text.length) {
    TERM.lastIndex = at;
    const match = TERM.exec(text);
    if (!match) return null;
    terms++;
    // A unitless number is milliseconds — but only alone: in `1m30` the `30`
    // is ambiguous, so it is refused rather than guessed.
    if (match[2] === "" && (terms > 1 || TERM.lastIndex < text.length))
      return null;
    const scale = UNIT_MS[match[2] === "" ? "ms" : match[2]!];
    if (scale === undefined) return null;
    total += Number(match[1]) * scale;
    at = TERM.lastIndex;
    while (text[at] === " ") at++;
  }
  return total;
}
