import type { InteractionBreakdown, StallFrame } from "../../core";
import { STALL } from "./constants";

// Tunables of the slow-interaction detector (see ../../CLAUDE.md, "Slow
// interactions"). Durations are Event Timing's: input → next paint.
export const INTERACTION = {
  // The Event Timing observer's own bar (a multiple of 8, ≥ 16), and the bar
  // an interaction is recorded at (slow-op, Timeline): Web Vitals' INP "needs
  // improvement" boundary.
  RECORD_MIN_MS: 200,
  // One interaction this slow is reported at once.
  SEVERE_MS: 800,
  // An interaction this slow is reported once the same target has had
  // RECUR_COUNT of them in this page load (this one included).
  RECUR_MIN_MS: 300,
  RECUR_COUNT: 3,
  // How long after an interaction's entry its long frames are waited for
  // (both are delivered after the paint), and how long a 1–5 s long frame
  // waits for the interaction that may own it.
  GRACE_MS: 1000,
  // Raw long frames kept for attribution, and dispatched events kept to
  // resolve an entry's target.
  FRAME_RING_MS: 10_000,
  DISPATCH_RING: 32,
  // An entry's startTime is its event's timeStamp; tolerance when matching.
  DISPATCH_MATCH_MS: 1,
  MAX_FRAMES: 5,
} as const;

/** One script of a long animation frame, on the page's performance clock. */
export interface RawScript {
  start: number;
  duration: number;
  forced: number;
  /** `function (invoker)` — the stall detector's attribution spelling. */
  label: string;
}

/** One long animation frame, on the page's performance clock. */
export interface RawFrame {
  start: number;
  end: number;
  /** 0 when the frame had no style/layout pass. */
  styleAndLayoutStart: number;
  scripts: readonly RawScript[];
  /** The same frame on the wall clock, as the payload carries it. */
  frame: StallFrame;
}

/** An interaction's window on the performance clock: input → next paint. */
export interface InteractionWindow {
  start: number;
  end: number;
}

export interface Attribution {
  breakdown: InteractionBreakdown;
  topFunction: string | null;
  forcedBy: string | null;
  /** The frames overlapping the window, oldest first (capped). */
  frames: StallFrame[];
}

const overlap = (a0: number, a1: number, b0: number, b1: number): number =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

const overlaps = (f: { start: number; end: number }, w: InteractionWindow) =>
  f.start < w.end && f.end > w.start;

/**
 * Where an interaction's time went, from the long frames inside it: every
 * script clipped to the window (its forced style/layout pro rata), the frame's
 * own style/layout pass less the scripts that ran inside it (ResizeObserver
 * callbacks run there), and the rest as `other`. The four sum to the window.
 */
export function attribute(
  w: InteractionWindow,
  frames: readonly RawFrame[],
): Attribution {
  const inside = frames
    .filter((f) => overlaps(f, w))
    .sort((a, b) => a.start - b.start);
  let scriptMs = 0;
  let forcedMs = 0;
  let styleLayoutMs = 0;
  const byLabel = new Map<string, { ms: number; forced: number }>();
  for (const f of inside) {
    const slStart = f.styleAndLayoutStart > 0 ? f.styleAndLayoutStart : null;
    let scriptsInStyleLayout = 0;
    for (const s of f.scripts) {
      const ms = overlap(s.start, s.start + s.duration, w.start, w.end);
      if (ms <= 0) continue;
      const forced =
        s.duration > 0 ? Math.min(ms, (s.forced * ms) / s.duration) : 0;
      scriptMs += ms - forced;
      forcedMs += forced;
      const agg = byLabel.get(s.label) ?? { ms: 0, forced: 0 };
      agg.ms += ms;
      agg.forced += forced;
      byLabel.set(s.label, agg);
      if (slStart !== null)
        scriptsInStyleLayout += overlap(
          s.start,
          s.start + s.duration,
          Math.max(slStart, w.start),
          Math.min(f.end, w.end),
        );
    }
    if (slStart !== null)
      styleLayoutMs += Math.max(
        0,
        overlap(slStart, f.end, w.start, w.end) - scriptsInStyleLayout,
      );
  }
  const total = w.end - w.start;
  const otherMs = Math.max(0, total - scriptMs - forcedMs - styleLayoutMs);
  let topFunction: string | null = null;
  let forcedBy: string | null = null;
  let topMs = 0;
  let topForced = 0;
  for (const [label, agg] of byLabel) {
    if (agg.ms > topMs) {
      topMs = agg.ms;
      topFunction = label;
    }
    if (agg.forced > topForced) {
      topForced = agg.forced;
      forcedBy = label;
    }
  }
  return {
    breakdown: {
      scriptMs: Math.round(scriptMs),
      forcedStyleLayoutMs: Math.round(forcedMs),
      styleLayoutMs: Math.round(styleLayoutMs),
      otherMs: Math.round(otherMs),
    },
    topFunction,
    // A forced layout under a millisecond names nobody.
    forcedBy: topForced >= 1 ? forcedBy : null,
    frames: inside.slice(0, INTERACTION.MAX_FRAMES).map((f) => f.frame),
  };
}

export type InteractionVerdict = "record" | "report";

/**
 * What one slow interaction becomes, given how many interactions of at least
 * RECUR_MIN_MS its target has had in this page load (this one included):
 * always a slow-op; a report when severe or recurring — except a freeze of the
 * stall detector's size, which files its own report.
 */
export function judgeInteraction(
  durationMs: number,
  recurCount: number,
): InteractionVerdict {
  if (durationMs >= STALL.REPORT_MIN_MS) return "record";
  if (durationMs >= INTERACTION.SEVERE_MS) return "report";
  if (
    durationMs >= INTERACTION.RECUR_MIN_MS &&
    recurCount >= INTERACTION.RECUR_COUNT
  )
    return "report";
  return "record";
}

/**
 * Whether a long frame belongs to a slow interaction — then the interaction,
 * which names what was interacted with, owns it, and the frame is not filed as
 * an app + route `main-thread` slow-op too.
 */
export function frameClaimed(
  frame: { start: number; end: number },
  interactions: readonly InteractionWindow[],
): boolean {
  return interactions.some((w) => overlaps(frame, w));
}

/** The Event Timing fields the detector reads. */
export interface EventTimingLike {
  readonly name: string;
  readonly startTime: number;
  readonly duration: number;
  readonly processingStart: number;
  readonly processingEnd: number;
  readonly interactionId: number;
}

/** The entry that stands for an interaction: its longest (the INP rule). */
export function longestEntry<E extends EventTimingLike>(
  entries: readonly E[],
): E {
  const first = entries[0];
  if (!first) throw new Error("longestEntry: an interaction with no entry");
  return entries.reduce((a, b) => (b.duration > a.duration ? b : a), first);
}

/** Event Timing's three phases of one entry, in ms. */
export function phasesOf(e: EventTimingLike): {
  inputDelayMs: number;
  processingMs: number;
  presentationDelayMs: number;
} {
  const end = e.startTime + e.duration;
  return {
    inputDelayMs: Math.round(Math.max(0, e.processingStart - e.startTime)),
    processingMs: Math.round(Math.max(0, e.processingEnd - e.processingStart)),
    presentationDelayMs: Math.round(Math.max(0, end - e.processingEnd)),
  };
}
