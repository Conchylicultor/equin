import type { TimelineEvent } from "../../../core";
import { overlapsWindow } from "../window";

// Structural view of a paired boot event — the pure mapping stays testable
// without importing the boot-events reader (and its log-channels chain).
export interface BootEventLike {
  processStartedAt: number; // wall-clock epoch ms
  // null = the backend never became ready (wedged/killed mid-boot, or still
  // booting): superseded attempts are bounded by supersededAtMs, the latest
  // one renders open-ended to the window's right edge.
  readyAt: number | null;
  // Set when the process exited before ready (a boot crash): the bar ends there.
  exitedAt: number | null;
  // Set when the boot watchdog saw the process gone (killed before ready, no
  // line of its own): known dead by then, so the bar ends there, not at now.
  deadBy: number | null;
  supersededAtMs: number | null;
}

// A boot is the wall-clock interval [processStartedAt, readyAt] — a
// deploy-restart burst renders as a stack of these bars. A never-ready boot
// renders to its exit (a boot crash), to its superseding attempt's start
// (warning: a failed attempt), to when it was known dead (killed before ready)
// or open-ended to toMs with the in-flight pulse (possibly booting right now,
// possibly wedged — the previously-invisible case). `worktree` is the log-dir
// name the events were read from (== the lane), not the line's own field, so
// the chunk and its events can never disagree.
export function mapBootEvents(
  events: readonly BootEventLike[],
  worktree: string,
  fromMs: number,
  toMs: number,
): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const e of events) {
    if (e.readyAt !== null) {
      if (!overlapsWindow(e.processStartedAt, e.readyAt, fromMs, toMs)) continue;
      out.push({
        id: `boot:${worktree}:${e.readyAt}`,
        source: "boot" as const,
        worktree,
        startMs: e.processStartedAt,
        endMs: e.readyAt,
        label: "backend boot",
        severity: "info" as const,
        detail: {
          processStartedAt: e.processStartedAt,
          readyAt: e.readyAt,
          bootMs: e.readyAt - e.processStartedAt,
        },
      });
      continue;
    }
    if (e.exitedAt !== null) {
      if (!overlapsWindow(e.processStartedAt, e.exitedAt, fromMs, toMs))
        continue;
      out.push({
        id: `boot:${worktree}:start:${e.processStartedAt}`,
        source: "boot" as const,
        worktree,
        startMs: e.processStartedAt,
        endMs: e.exitedAt,
        label: "backend boot (crashed)",
        severity: "warning" as const,
        detail: {
          processStartedAt: e.processStartedAt,
          readyAt: null,
          exitedAt: e.exitedAt,
          bootMs: e.exitedAt - e.processStartedAt,
        },
      });
      continue;
    }
    const open = e.supersededAtMs === null && e.deadBy === null;
    const endMs = e.supersededAtMs ?? e.deadBy ?? toMs;
    if (!overlapsWindow(e.processStartedAt, endMs, fromMs, toMs)) continue;
    out.push({
      id: `boot:${worktree}:start:${e.processStartedAt}`,
      source: "boot" as const,
      worktree,
      startMs: e.processStartedAt,
      endMs,
      label: open
        ? "backend boot (in progress or wedged)"
        : e.supersededAtMs === null
          ? "backend boot (killed before ready)"
          : "backend boot (never ready)",
      // A bounded never-ready attempt is a known-failed boot; an open one may
      // simply be a boot in progress at refresh time, so it stays info and
      // pulses (the in-flight convention).
      severity: open ? ("info" as const) : ("warning" as const),
      detail: {
        processStartedAt: e.processStartedAt,
        readyAt: null,
        supersededAtMs: e.supersededAtMs,
        ...(e.deadBy !== null && { deadBy: e.deadBy }),
        inFlight: open,
      },
    });
  }
  return out;
}
