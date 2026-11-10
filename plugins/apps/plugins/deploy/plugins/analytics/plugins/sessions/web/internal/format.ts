/** A clock offset: `m:ss`, or `h:mm:ss` past an hour (the timeline's +times). */
export function clock(s: number): string {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A span in words: `42s`, `3m 05s`, `1h 07m`. */
export function span(s: number): string {
  const t = Math.max(0, Math.round(s));
  const pad = (n: number) => String(n).padStart(2, "0");
  if (t < 60) return `${t}s`;
  if (t < 3600) return `${Math.floor(t / 60)}m ${pad(t % 60)}s`;
  return `${Math.floor(t / 3600)}h ${pad(Math.floor((t % 3600) / 60))}m`;
}

/** The median of `values` (the lower middle on an even count); `null` for none. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/** A country code's flag emoji (regional indicators); `null` for none or a non-code. */
export function flagOf(country: string | null): string | null {
  if (country === null || !/^[A-Z]{2}$/.test(country)) return null;
  return String.fromCodePoint(
    ...[...country].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}

const regionNames =
  typeof Intl.DisplayNames === "function"
    ? new Intl.DisplayNames(undefined, { type: "region" })
    : null;

/** A country code in words ("France"); the code itself when unknown, "Unknown" for none. */
export function countryName(country: string | null): string {
  if (country === null) return "Unknown location";
  return regionNames?.of(country) ?? country;
}

/** "14:32" in the reader's zone. */
export function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}
