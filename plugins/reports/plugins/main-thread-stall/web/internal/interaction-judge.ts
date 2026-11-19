import type {
  InteractionBreakdown,
  InteractionTarget,
  StallFrame,
  StallInteraction,
} from "../../core";
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
  // The part of a long frame's free wait for its render step that is still a
  // normal wait for the next vsync (LoAF's own long-frame bar): only the rest
  // is rendering the browser withheld.
  WITHHELD_SLACK_MS: 50,
  // A throttled renderer withholds frame after frame: only when at least
  // THROTTLED_FRAMES long frames inside the interaction each waited this long
  // (free) for their render step is the wait the browser's. One suppressed
  // frame is the page's own (a view transition awaiting its update, a
  // compositor busy rastering what the page drew).
  THROTTLED_WAIT_MS: 500,
  THROTTLED_FRAMES: 2,
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
  /** When its render step began; 0 when it had none. */
  renderStart: number;
  /** LoAF's blockingDuration: how long its long tasks (and render) held input. */
  blocking: number;
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
 * callbacks run there), the rendering the browser withheld (`withheldOf`,
 * counted from `withheldFrom` — the handlers' start, never the input delay —
 * and only from a throttled renderer: `throttled`), and the rest as `other`.
 * The five sum to the window. `withheldFrom` null: not measured (the frames'
 * scripts are capped, so their free time cannot be told) — `withheldMs` null.
 */
export function attribute(
  w: InteractionWindow,
  frames: readonly RawFrame[],
  withheldFrom: number | null,
): Attribution {
  const inside = frames
    .filter((f) => overlaps(f, w))
    .sort((a, b) => a.start - b.start);
  let scriptMs = 0;
  let forcedMs = 0;
  let styleLayoutMs = 0;
  let withheldMs = 0;
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
    if (withheldFrom !== null)
      withheldMs += withheldOf(f, {
        start: Math.max(w.start, withheldFrom),
        end: w.end,
      });
  }
  if (!throttled(inside)) withheldMs = 0;
  const total = w.end - w.start;
  // Never more than the window less what the page ran.
  withheldMs = Math.min(
    withheldMs,
    Math.max(0, total - scriptMs - forcedMs - styleLayoutMs),
  );
  const otherMs = Math.max(
    0,
    total - scriptMs - forcedMs - styleLayoutMs - withheldMs,
  );
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
      withheldMs: withheldFrom === null ? null : Math.round(withheldMs),
      otherMs: Math.round(otherMs),
    },
    topFunction,
    // A forced layout under a millisecond names nobody.
    forcedBy: topForced >= 1 ? forcedBy : null,
    frames: inside.slice(0, INTERACTION.MAX_FRAMES).map((f) => f.frame),
  };
}

/**
 * The rendering the browser withheld from one long frame, inside the window:
 * the frame's wait for its render step (its start → render start, clipped to
 * the window) that no script filled, less every ms its tasks blocked (LoAF's
 * `blockingDuration` counts work no script attribution names) and less a
 * vsync's slack. A frame waits for its render step only while the browser
 * gives it no frame: with the thread free, a visible page renders within a
 * vsync of asking, so a long free wait is the browser's (a renderer throttled
 * to ~1 frame/s: an occluded or off-screen window, an automated browser), never
 * the page's. A frame whose tasks blocked keeps that time as theirs.
 */
export function withheldOf(f: RawFrame, w: InteractionWindow): number {
  return Math.max(0, freeWait(f, w) - INTERACTION.WITHHELD_SLACK_MS);
}

/** A frame's wait for its render step, inside `w`, that no script filled and no task blocked. */
function freeWait(f: RawFrame, w: InteractionWindow): number {
  const renderAt = f.renderStart > 0 ? f.renderStart : f.end;
  const from = Math.max(f.start, w.start);
  const to = Math.min(renderAt, w.end);
  if (to <= from) return 0;
  let scripts = 0;
  for (const s of f.scripts)
    scripts += overlap(s.start, s.start + s.duration, from, to);
  return Math.max(0, to - from - scripts - f.blocking);
}

/**
 * Whether the frames show a renderer the browser throttled: THROTTLED_FRAMES
 * of them each waited THROTTLED_WAIT_MS or more, free, for their render step
 * (over the whole frame — the cadence is the renderer's, not the click's).
 */
export function throttled(frames: readonly RawFrame[]): boolean {
  const waited = frames.filter(
    (f) =>
      freeWait(f, { start: f.start, end: f.end }) >=
      INTERACTION.THROTTLED_WAIT_MS,
  );
  return waited.length >= INTERACTION.THROTTLED_FRAMES;
}

/** What the page itself spent of an interaction: its own time less the rendering the browser withheld. */
export function pageOwnMs(ownMs: number, b: InteractionBreakdown): number {
  return Math.max(0, ownMs - (b.withheldMs ?? 0));
}

/**
 * A frame as the watchdog holds it (wall clock) as a raw frame on the same
 * clock: the worker has no LoAF entry, only what the tab posted. A script
 * recorded without its start is placed at its frame's start.
 */
export function rawFrameOf(f: StallFrame): RawFrame {
  return {
    start: f.startedAt,
    end: f.startedAt + f.durationMs,
    styleAndLayoutStart:
      f.styleAndLayoutStartMs === null
        ? 0
        : f.startedAt + f.styleAndLayoutStartMs,
    renderStart: f.renderStartMs === null ? 0 : f.startedAt + f.renderStartMs,
    blocking: f.blockingDurationMs,
    scripts: f.scripts.map((s) => {
      const fn = s.sourceFunctionName || "(anonymous)";
      return {
        start: f.startedAt + (s.startMs ?? 0),
        duration: s.durationMs,
        forced: s.forcedStyleAndLayoutDurationMs,
        label: s.invoker ? `${fn} (${s.invoker})` : fn,
      };
    }),
    frame: f,
  };
}

/** A user interaction as the tab tells the watchdog at dispatch (before any handler runs). */
export interface InteractionBegin {
  target: InteractionTarget;
  eventType: string;
  /** Epoch ms of the event (its timeStamp on the wall clock: page-clock's perfToEpoch). */
  at: number;
}

/**
 * The interaction a freeze started from, its time from the input to the
 * freeze's end split by the long frames held for it (wall clock). None held
 * (the tab never came back): all of it is `other`.
 */
export function stallInteraction(
  begin: InteractionBegin,
  frames: readonly StallFrame[],
  endedAt: number,
): StallInteraction {
  // Not measured: the watchdog holds each frame's longest scripts only.
  const a = attribute(
    { start: begin.at, end: Math.max(begin.at, endedAt) },
    frames.map(rawFrameOf),
    null,
  );
  return {
    target: begin.target,
    eventType: begin.eventType,
    startedAt: begin.at,
    breakdown: a.breakdown,
    forcedBy: a.forcedBy,
  };
}

export type InteractionVerdict = "record" | "report";

/**
 * What one slow interaction becomes — judged on the time the PAGE spent
 * (`pageOwnMs`: its own time less the rendering the browser withheld) — given
 * how many interactions of at least RECUR_MIN_MS its target has had in this
 * page load (this one included):
 * always a slow-op; a report when severe or recurring — except a freeze of the
 * stall detector's size (`frozen`: a long frame inside it reached the stall
 * bar, which is the bar the stall detector applies), whose own report names
 * this interaction.
 */
export function judgeInteraction(
  durationMs: number,
  recurCount: number,
  frozen: boolean,
): InteractionVerdict {
  if (frozen || durationMs >= STALL.REPORT_MIN_MS) return "record";
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

/**
 * Where an entry's OWN time ends (performance clock): at its paint, unless a
 * later interaction's handlers began after this entry's handlers ended and
 * before that paint — then at the first of them. Several inputs dispatched
 * inside one frame (`Alt+N`: keydown Alt, keydown N) all share its paint, so
 * each entry's presentation delay would include every later one's work: the
 * Alt keydown, whose handlers do nothing, would carry what N's new-window
 * handler did. From where the later handlers begin, the time is theirs.
 *
 * `laterHandlers`: when each other interaction's handlers began (a trusted
 * keydown / pointerdown, read at dispatch) — the starts of NEW interactions
 * only, never a later event of this same one (its click after a pointerdown).
 */
export function ownEnd(
  e: EventTimingLike,
  laterHandlers: readonly number[],
): number {
  let end = e.startTime + e.duration;
  for (const t of laterHandlers) if (t > e.processingEnd && t < end) end = t;
  return end;
}
