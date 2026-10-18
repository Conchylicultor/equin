import {
  bytesText,
  diskAlarmOf,
  SIGNAL_KEYS,
  type DiskAlarm,
  type SentinelVitalsRecord,
  type SignalKey,
} from "@plugins/debug/plugins/sentinel/plugins/status-file/core";
import { clockTime } from "./machine-watcher-health";

// The Machine watcher row's glance and detail, as a pure view model: one
// recorded reading + `now` → the words, numbers and tones the two components
// draw. Pure so the tone thresholds, staleness and wording are unit-tested
// without rendering. Wording and tone rules: prototype proto-1789664064-nr56.

/** `bad` at or past the limit, `warn` past two-thirds of it. */
export type VitalTone = "neutral" | "warn" | "bad";

/** A reading older than this many ticks is no longer shown as live. */
const STALE_TICKS = 3;

/** Free memory below these reads amber / red in the glance. */
const FREE_WARN_MB = 3 * 1024;
const FREE_BAD_MB = 1024;

/** What a missing reading shows in place of a number. */
const MISSING = "—";

interface SignalSpec {
  /** The line's label in the detail. */
  label: string;
  /** How the signal is named in the trip banner ("Tripped by load and …"). */
  cause: string;
  format: (value: number) => string;
}

function thousands(n: number): string {
  return n >= 1000 ? `${String(Math.round(n / 1000))}k` : String(Math.round(n));
}

function milliseconds(n: number): string {
  return n >= 1000
    ? `${(n / 1000).toFixed(1)} s`
    : `${String(Math.round(n))} ms`;
}

const SIGNALS: Record<SignalKey, SignalSpec> = {
  loadRatio: {
    label: "Load per core",
    cause: "load",
    format: (v) => v.toFixed(2),
  },
  decompressionsPerSec: {
    label: "Memory compression",
    cause: "memory compression",
    format: (v) => `${thousands(v)}/s`,
  },
  locksWaiting: {
    label: "Waiting database locks",
    cause: "waiting database locks",
    format: (v) => String(Math.round(v)),
  },
  blkReadDeltaMs: {
    label: "Database disk reads",
    cause: "database disk reads",
    format: milliseconds,
  },
  slowBackends: {
    label: "Slow worktrees",
    cause: "slow worktrees",
    format: (v) => String(Math.round(v)),
  },
};

export function toneOf(value: number | null, limit: number): VitalTone {
  if (value === null) return "neutral";
  if (value >= limit) return "bad";
  if (value >= (limit * 2) / 3) return "warn";
  return "neutral";
}

export interface SignalLineView {
  key: SignalKey;
  label: string;
  /** The reading, or "—" when it could not be read this tick. */
  valueText: string;
  limitText: string;
  /** How full the bar is, 0..1 (0 for a missing reading). */
  fraction: number;
  tone: VitalTone;
}

export interface GlanceFigureView {
  key: "load" | "free" | "disk" | "builds";
  /** Plain words before the emphasised value. */
  before: string;
  value: string;
  /** Plain words after it. */
  after: string;
  tone: VitalTone;
}

/** The note under the summary: what tripped the watcher, or why the numbers are old. */
export type BannerView =
  { kind: "tripped"; text: string } | { kind: "stale"; text: string };

export interface VitalsView {
  /** No new reading for a while, or not from the watcher running now: draw greyed. */
  stale: boolean;
  banner: BannerView | null;
  glance: GlanceFigureView[];
  signals: SignalLineView[];
  /** "11 worktrees running · Updated 3s ago". */
  footer: string;
}

function fractionOf(value: number | null, limit: number): number {
  if (value === null) return 0;
  if (limit <= 0) return value > 0 ? 1 : 0;
  return Math.max(0, Math.min(1, value / limit));
}

/** "a", "a and b", "a, b and c". */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** "3s ago", "4m ago", "2h ago". */
export function ageText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${String(s)}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m ago`;
  return `${String(Math.floor(m / 60))}h ago`;
}

/** "40 seconds", "2 minutes", "3 hours". */
function spanText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return plural(s, "second", "seconds");
  const m = Math.floor(s / 60);
  if (m < 60) return plural(m, "minute", "minutes");
  return plural(Math.floor(m / 60), "hour", "hours");
}

function bannerOf(
  vitals: SentinelVitalsRecord,
  now: number,
  current: boolean,
  late: boolean,
): BannerView | null {
  const at = clockTime(vitals.wall);
  if (!current) {
    return {
      kind: "stale",
      text: `These numbers are from a machine watcher that is not running now, last read at ${at}.`,
    };
  }
  if (late) {
    return {
      kind: "stale",
      text: `No new reading for ${spanText(now - vitals.wall)}. These numbers are from ${at}.`,
    };
  }
  if (!vitals.tripped) return null;
  // Tripped with nothing elevated: the detector is waiting out its calm dwell
  // (or adopted an episode it did not trip).
  const causes = SIGNAL_KEYS.filter((k) => vitals.elevated.includes(k)).map(
    (k) => SIGNALS[k].cause,
  );
  return {
    kind: "tripped",
    text:
      causes.length > 0
        ? `Tripped by ${listOf(causes)}`
        : "Under duress · waiting for every signal to calm down",
  };
}

const DISK_TONE: Record<DiskAlarm, VitalTone> = {
  ok: "neutral",
  low: "warn",
  filling: "warn",
  "full-soon": "bad",
  full: "bad",
};

/** "412 GB disk free", with how fast it is falling while that is alarming. */
function diskFigure(
  disk: SentinelVitalsRecord["context"]["disk"],
): GlanceFigureView {
  if (disk === null) {
    return {
      key: "disk",
      before: "",
      value: `${MISSING} GB`,
      after: " disk free",
      tone: "neutral",
    };
  }
  const alarm = diskAlarmOf(disk);
  const rate = disk.fillBytesPerSec;
  const falling =
    (alarm === "filling" || alarm === "full-soon") && rate !== null
      ? ` (−${bytesText(rate * 60)}/min)`
      : "";
  return {
    key: "disk",
    before: "",
    value: bytesText(disk.freeBytes),
    after: ` disk free${falling}`,
    tone: DISK_TONE[alarm],
  };
}

function glanceOf(vitals: SentinelVitalsRecord): GlanceFigureView[] {
  const load = vitals.signals.loadRatio;
  const { freeMemMb, inFlightBuilds } = vitals.context;
  return [
    {
      key: "load",
      before: "Load ",
      value:
        load.value === null ? MISSING : SIGNALS.loadRatio.format(load.value),
      after: " per core",
      tone: toneOf(load.value, load.limit),
    },
    {
      key: "free",
      before: "",
      value:
        freeMemMb === null
          ? `${MISSING} GB`
          : `${(freeMemMb / 1024).toFixed(1)} GB`,
      after: " memory free",
      tone:
        freeMemMb === null
          ? "neutral"
          : freeMemMb < FREE_BAD_MB
            ? "bad"
            : freeMemMb < FREE_WARN_MB
              ? "warn"
              : "neutral",
    },
    diskFigure(vitals.context.disk),
    {
      key: "builds",
      before: "",
      value: inFlightBuilds === null ? MISSING : String(inFlightBuilds),
      after: inFlightBuilds === 1 ? " build" : " builds",
      tone: "neutral",
    },
  ];
}

/** The view of one recorded reading at `now`. */
export function vitalsView(
  vitals: SentinelVitalsRecord,
  current: boolean,
  now: number,
): VitalsView {
  const late = now - vitals.wall > STALE_TICKS * vitals.cadenceMs;
  const signals = SIGNAL_KEYS.map((key): SignalLineView => {
    const { value, limit } = vitals.signals[key];
    const spec = SIGNALS[key];
    return {
      key,
      label: spec.label,
      valueText: value === null ? MISSING : spec.format(value),
      limitText: spec.format(limit),
      fraction: fractionOf(value, limit),
      tone: toneOf(value, limit),
    };
  });
  const running = vitals.context.runningBackends;
  const updated = `Updated ${ageText(now - vitals.wall)}`;
  return {
    stale: late || !current,
    banner: bannerOf(vitals, now, current, late),
    glance: glanceOf(vitals),
    signals,
    footer:
      running === null
        ? updated
        : `${plural(running, "worktree", "worktrees")} running · ${updated}`,
  };
}
