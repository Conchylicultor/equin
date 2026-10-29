import type { FieldOptionMeta } from "@plugins/fields/core";
import type { BadgeVariant } from "@plugins/primitives/plugins/css/plugins/badge/core";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import type {
  BackgroundEntry,
  BackgroundRun,
  BackgroundRunOutcome,
  BackgroundScope,
  BackgroundTrigger,
} from "../../core";

/**
 * What a row's status dot says, derived from the entry — one answer, in
 * precedence order: a schedule turned off, work that happens on another
 * backend, then the latest run here.
 */
export type EntryStatus =
  "disabled" | "elsewhere" | "never" | BackgroundRunOutcome;

export function entryStatus(entry: BackgroundEntry): EntryStatus {
  if (entry.trigger.kind === "cron" && entry.trigger.disabled)
    return "disabled";
  if (!entry.runsHere) return "elsewhere";
  if (entry.lastRun === null) return "never";
  return entry.lastRun.outcome;
}

// Each status declares its colour and glyph; the run outcomes share the one run
// vocabulary's colours, so a failed job here is the same red as a failed build.
export const ENTRY_STATUS_OPTIONS = {
  running: { label: "Running", variant: "info", icon: symbol("timelapse") },
  failed: { label: "Failed", variant: "destructive", icon: symbol("error") },
  succeeded: {
    label: "Succeeded",
    variant: "success",
    icon: symbol("check-circle"),
  },
  suspended: {
    label: "Handed off",
    variant: "muted",
    icon: symbol("pause-circle"),
  },
  never: {
    label: "Not run yet",
    variant: "muted",
    icon: symbol("radio-button-unchecked"),
  },
  elsewhere: {
    label: "Runs on main",
    variant: "muted",
    icon: symbol("radio-button-unchecked"),
  },
  disabled: { label: "Disabled", variant: "muted", icon: symbol("cancel") },
} as const satisfies Record<EntryStatus, FieldOptionMeta>;

/** The given statuses as a field's options (label, colour, glyph). */
export function entryStatusOptions(values: readonly EntryStatus[]): {
  value: EntryStatus;
  label: string;
  variant: BadgeVariant;
  icon: IconRef;
}[] {
  return values.map((value) => ({ value, ...ENTRY_STATUS_OPTIONS[value] }));
}

export const SCOPE_LABEL: Record<BackgroundScope, string> = {
  main: "Main only",
  "every-worktree": "Every worktree",
  central: "Central (machine-wide)",
};

/** When it runs, in words. */
export function triggerWords(trigger: BackgroundTrigger): string {
  switch (trigger.kind) {
    case "cron":
      return trigger.words;
    case "event":
      return trigger.names.length > 0
        ? `When ${trigger.names.join(" or ")} fires`
        : "When an event fires";
    case "boot":
      return "After boot";
    case "on-demand":
      return "When asked";
    case "interval":
      return `Every ${formatPeriod(trigger.everyMs)}`;
    case "file-change":
      return "When watched files change";
  }
}

/**
 * A period in the largest whole unit it is a multiple of: `second`,
 * `10 seconds`, `minute`, `5 minutes`, `hour` — falling back to milliseconds.
 */
export function formatPeriod(ms: number): string {
  const units: [number, string][] = [
    [3_600_000, "hour"],
    [60_000, "minute"],
    [1_000, "second"],
  ];
  for (const [size, unit] of units) {
    if (ms >= size && ms % size === 0) {
      const n = ms / size;
      return n === 1 ? unit : `${n} ${unit}s`;
    }
  }
  return `${ms} ms`;
}

/**
 * Wall-clock milliseconds at a glance: `40ms`, `3.1s`, `4m 12s`, `2h 05m`.
 * Sub-second precision matters here — most background runs take milliseconds.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** A future instant relative to `now`: `in 12s`, `in 4m`, `in 3h`, `in 2d`. */
export function formatUntil(at: Date, now: number): string {
  const s = Math.max(0, Math.round((at.getTime() - now) / 1000));
  if (s < 60) return s <= 1 ? "now" : `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

/** A finished run's result in a few characters: its duration, or `failed`. */
export function runResultText(run: BackgroundRun): string {
  if (run.outcome === "failed") return "failed";
  if (run.durationMs === null) return "running";
  return formatDuration(run.durationMs);
}
