import {
  NONE_VALUE,
  parseEventPropValue,
  type AnalyticsRange,
  type Dimension,
  type Granularity,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";

const countFormatter = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
const exactFormatter = new Intl.NumberFormat();

/** A count: exact below 10k, compact above. */
export function formatCount(n: number): string {
  return n >= 10_000 ? countFormatter.format(n) : exactFormatter.format(n);
}

export function formatPercent(fraction: number): string {
  const pct = fraction * 100;
  return `${pct > 0 && pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** An average count: one decimal ("4.2"). */
export function formatAverage(n: number): string {
  return n.toFixed(1);
}

/** An optional rate: a missing denominator reads as a dash, never as zero. */
export function orDash<T>(value: T | null, format: (v: T) => string): string {
  return value === null ? "—" : format(value);
}

export const RANGE_OPTIONS: readonly { id: AnalyticsRange; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "12m", label: "12 months" },
];

/** "previous 7 days" — the dashed line's legend. */
export function previousPeriodLabel(range: AnalyticsRange): string {
  return range === "today"
    ? "Yesterday"
    : `Previous ${RANGE_OPTIONS.find((r) => r.id === range)!.label}`;
}

/** An x-axis tick for one series bucket (all buckets are UTC). */
export function formatBucket(bucket: string, granularity: Granularity): string {
  switch (granularity) {
    case "hour":
      return `${bucket.slice(11, 13)}:00`;
    case "day":
      return new Date(`${bucket}T00:00:00Z`).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
    case "month":
      return new Date(`${bucket}T00:00:00Z`).toLocaleDateString(undefined, {
        month: "short",
        year: "2-digit",
        timeZone: "UTC",
      });
  }
}

/** How a filter chip names its dimension: "Channel is Search". */
export const DIMENSION_LABEL: Record<Dimension, string> = {
  page: "Page",
  entry_page: "Entry page",
  exit_page: "Exit page",
  channel: "Channel",
  referrer_host: "Referrer",
  referrer_path: "Linking page",
  utm_campaign: "Campaign",
  country: "Country",
  language: "Language",
  device: "Device",
  browser: "Browser",
  os: "OS",
  event: "Event",
  event_prop: "Event",
};

/*
 * The browser's language, named explicitly rather than left to the runtime
 * default: a runtime with no locale ("und") names no region at all, so every
 * country would silently read as its bare code.
 *
 * Built on first use, not at module load: build-time tooling imports this
 * barrel outside a browser, where `navigator.language` is not set.
 */
let regionNames: Intl.DisplayNames | undefined;
function getRegionNames(): Intl.DisplayNames {
  regionNames ??= new Intl.DisplayNames([navigator.language], {
    type: "region",
  });
  return regionNames;
}

/** "France (FR)"; a code the platform cannot name reads as the code itself. */
function countryLabel(code: string): string {
  if (code === NONE_VALUE) return code;
  let name: string | undefined;
  try {
    name = getRegionNames().of(code);
  } catch (err) {
    // A string that is not a region code at all: show it as stored.
    if (err instanceof RangeError) return code;
    throw err;
  }
  return name === undefined || name === code ? code : `${name} (${code})`;
}

/**
 * How a dimension's stored value is shown — in a ranked row and in its filter
 * chip alike. Dimensions not listed show the value as stored. The value that
 * is filtered on is always the stored one; only its display changes.
 */
const VALUE_LABEL: Partial<Record<Dimension, (value: string) => string>> = {
  country: countryLabel,
  event_prop: eventPropLabel,
};

/** "foundations_card_open · card: Agent manager". */
function eventPropLabel(stored: string): string {
  const { event, key, value } = parseEventPropValue(stored);
  return `${event} · ${key}: ${value}`;
}

export function dimensionValueLabel(
  dimension: Dimension,
  value: string,
): string {
  const label = VALUE_LABEL[dimension];
  return label ? label(value) : value;
}
