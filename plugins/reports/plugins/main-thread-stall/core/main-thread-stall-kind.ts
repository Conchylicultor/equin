import { z } from "zod";
import {
  dominantLayer,
  InteractionBreakdownSchema,
  interactionTargetKey,
  interactionTargetLabel,
  InteractionTargetSchema,
} from "./interaction-target";

// The `main-thread-stall` report payload: a browser tab's main thread stopped
// answering for seconds. Filed by a live tab of the same origin on behalf of the
// stalled one (see ../CLAUDE.md), stored in the generic `data` jsonb column and
// validated on ingest by the server ReportKind.

// One script a long animation frame ran (LoAF `PerformanceScriptTiming`), the
// browser's own attribution of the frame's time.
export const StallFrameScriptSchema = z.object({
  invokerType: z.string(),
  invoker: z.string(),
  sourceURL: z.string(),
  sourceFunctionName: z.string(),
  sourceCharPosition: z.number(),
  // When the script began, in ms from its frame's start — what clips it to an
  // interaction's window. Null on frames recorded before it was kept.
  startMs: z.number().nullable().default(null),
  durationMs: z.number(),
  forcedStyleAndLayoutDurationMs: z.number(),
  pauseDurationMs: z.number(),
});
export type StallFrameScript = z.infer<typeof StallFrameScriptSchema>;

// One long animation frame (LoAF entry) on the wall clock: `startedAt` is epoch
// ms (timeOrigin + startTime), the offsets are ms from the frame's start.
export const StallFrameSchema = z.object({
  startedAt: z.number(),
  durationMs: z.number(),
  blockingDurationMs: z.number(),
  renderStartMs: z.number().nullable(),
  styleAndLayoutStartMs: z.number().nullable(),
  // The longest scripts of the frame, longest first (capped).
  scripts: z.array(StallFrameScriptSchema),
});
export type StallFrame = z.infer<typeof StallFrameSchema>;

// One task mark (primitives/perfs/task-marks): what the tab said it was about
// to run, posted to the watchdog BEFORE running it (and its end after) — so a
// tab that froze inside the task had already said which. `at` is the tab's
// Date.now() when it began.
export const TaskMarkSchema = z.object({
  at: z.number(),
  source: z.string(),
  what: z.string(),
  detail: z.string(),
});
export type TaskMark = z.infer<typeof TaskMarkSchema>;

// Where a tab was when it was last heard from: its id (sessionStorage — it
// survives a reload), app, route pattern (pane ids, never params) and page.
export const StallTabSchema = z.object({
  tabId: z.string(),
  app: z.string().nullable(),
  routePattern: z.string(),
  url: z.string(),
  visible: z.boolean(),
  focused: z.boolean(),
});
export type StallTab = z.infer<typeof StallTabSchema>;

// The user interaction a freeze started from: a click, tap or key press the tab
// had dispatched, whose next paint had not come yet when the thread went
// silent. Posted to the watchdog AT DISPATCH (before any handler runs), so a
// tab that froze inside the interaction had already said what was clicked.
export const StallInteractionSchema = z.object({
  // What was interacted with — the same identity a slow-interaction report
  // carries (no typed text, no user-data labels).
  target: InteractionTargetSchema,
  // The dispatched event (pointerdown, click, keydown), and its epoch ms.
  eventType: z.string(),
  startedAt: z.number(),
  // Where the time from the input to the stall's end went, from the long
  // frames the watchdog holds (all `other` when none arrived: gone / unknown).
  breakdown: InteractionBreakdownSchema,
  // The script that forced the most style/layout inside it, if any.
  forcedBy: z.string().nullable(),
});
export type StallInteraction = z.infer<typeof StallInteractionSchema>;

// One aggregated main-thread JS stack the sampling profiler caught inside the
// stall: frames innermost first, each `name (url:line:col)`; `ms` is the
// sampled time spent in exactly this stack.
export const StallStackSchema = z.object({
  ms: z.number(),
  samples: z.number(),
  frames: z.array(z.string()),
});
export type StallStack = z.infer<typeof StallStackSchema>;

// What ran underneath the freeze's entry point, from the tab's rolling JS
// Self-Profiling trace (web/internal/stall-profiler.ts). `sampled` only for a
// stall the stalled tab itself survived and filed; otherwise `unavailable`
// with the reason — never an empty `sampled`, which would read as "no JS ran".
export const StallStacksSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sampled"),
    // The profiler's requested and the trace's actual mean sample interval.
    sampleIntervalMs: z.number(),
    // Sampled time inside the stall window, and how much of it ran no JS
    // (no stack: style, layout, paint, GC — or the thread not scheduled).
    sampledMs: z.number(),
    noJsMs: z.number(),
    // The profiler's buffer filled before the stall ended: the stacks cover
    // its first `sampledMs` only.
    truncated: z.boolean(),
    // The heaviest exact stacks, heaviest first (capped).
    stacks: z.array(StallStackSchema),
    // The heaviest innermost frames (self time across every stack), capped.
    topSelf: z.array(z.object({ frame: z.string(), ms: z.number() })),
  }),
  z.object({ kind: z.literal("unavailable"), reason: z.string() }),
]);
export type StallStacks = z.infer<typeof StallStacksSchema>;

export const MainThreadStallPayloadSchema = StallTabSchema.extend({
  // Epoch ms. `endedAt` is when the thread answered again (recovered), when
  // the tab went away (gone), or the last instant it was seen still frozen
  // (unknown — the duration is then a lower bound).
  startedAt: z.number(),
  endedAt: z.number(),
  durationMs: z.number(),
  durationIsLowerBound: z.boolean(),
  // recovered: the tab answered again on its own. gone: it was reloaded,
  // closed or killed while frozen. unknown: the watchdog itself died with the
  // stall open (last tab closed, browser quit); filed on its next start.
  ended: z.enum(["recovered", "gone", "unknown"]),
  // worker: the out-of-thread watchdog saw it. in-tab: the fallback when the
  // browser has no SharedWorker (LoAF, plus a heartbeat drained next load).
  detector: z.enum(["worker", "in-tab"]),
  // Long frames (≥ 200 ms) the stalled tab ran inside the stall window, by
  // their own timestamps. 0 means one task never yielded (an endless
  // synchronous loop) or no entry arrived; more means the thread still ran
  // frames — a render storm rather than one blocked task.
  framesDuring: z.number(),
  // The LoAF entry covering the stall — the definitive attribution — when the
  // tab recovered and reported it. Null for gone / unknown stalls.
  stallFrame: StallFrameSchema.nullable(),
  // Those frames themselves (the longest, capped), oldest first: what ran
  // during the freeze when no single entry covers it. Absent on reports
  // filed before it existed.
  during: z.array(StallFrameSchema).default([]),
  // The long frames that ended within 10 s before the stall began
  // (breadcrumbs), oldest first. Never the freeze itself.
  frames: z.array(StallFrameSchema),
  // The tab's task marks from the 10 s before the stall to its end (the latest,
  // capped), oldest first. Absent on reports filed before marks existed.
  marks: z.array(TaskMarkSchema).default([]),
  // The marked task still OPEN (begun, never ended) when the stall opened: the
  // task the thread froze in (LoAF names only its entry point, and a socket's
  // port handler runs every frame). Null: it froze outside every marked task.
  frozenIn: TaskMarkSchema.nullable().default(null),
  // The user interaction the freeze started from (its handlers or the render
  // they led to never reached a paint), when one did. Absent on reports filed
  // before it existed, and on freezes no interaction started.
  interaction: StallInteractionSchema.nullable().default(null),
  // Other tabs that froze with it (same renderer process): victims, not causes.
  cohort: z.array(StallTabSchema),
  // The longest-running script of `stallFrame` — or, without one, summed over
  // `during` — as `function (invoker)`; null when unattributed. THE
  // attribution grain of the fingerprint.
  topFunction: z.string().nullable(),
  // The main-thread JS stacks sampled during the stall (see StallStacksSchema).
  // Evidence only: never part of the fingerprint or summary.
  stacks: StallStacksSchema.default({
    kind: "unavailable",
    reason: "filed before stall reports carried sampled stacks",
  }),
});
export type MainThreadStallPayload = z.infer<
  typeof MainThreadStallPayloadSchema
>;

/**
 * A stall as the watchdog knows it: everything but `stacks`, which only the
 * stalled tab can add (its profiler ran on its own thread) when it files. It
 * is also all the fingerprint and summary may read — the same freeze stays
 * one row whatever its sampled stacks were.
 */
export type MainThreadStallDraft = Omit<MainThreadStallPayload, "stacks">;

/**
 * A freeze a user interaction started: the interaction's target alone — the
 * same control freezing again is the same row, on whatever screen, through
 * whichever function. Otherwise app + route pattern + the top attributed
 * function (or `unattributed`), then the frozen task's mark (`source:what`)
 * when it set one — LoAF's entry point alone lumps every frame a socket
 * handler runs together. No ids, durations or end kinds: the same freeze is
 * one row whose `count` grows, and its `data` is the newest sighting.
 */
export function mainThreadStallFingerprint(data: MainThreadStallDraft): string {
  if (data.interaction)
    return `main-thread-stall:interaction:${interactionTargetKey(data.interaction.target)}`;
  const task = data.frozenIn
    ? `|${data.frozenIn.source}:${data.frozenIn.what}`
    : "";
  return `main-thread-stall:${data.app ?? "-"}|${data.routePattern}|${data.topFunction ?? "unattributed"}${task}`;
}

/** The one-line summary used as the report message and the task title stem. */
export function mainThreadStallSummary(data: MainThreadStallDraft): string {
  const secs = (data.durationMs / 1000).toFixed(1);
  const at = `${data.app ?? "?"} ${data.routePattern}`;
  const who = data.topFunction ?? "unattributed";
  const frozen = `Main thread frozen ${data.durationIsLowerBound ? "≥" : ""}${secs}s (${data.ended})`;
  const i = data.interaction;
  if (i) {
    const top = dominantLayer(i.breakdown);
    const fn =
      i.forcedBy && top.layer === "forced style/layout"
        ? i.forcedBy
        : data.topFunction;
    return `${frozen} after ${interactionTargetLabel(i.target)} — ${at} — ${top.layer} ${top.ms} ms${fn ? ` (${fn})` : ""}`;
  }
  const task = data.frozenIn
    ? ` in ${data.frozenIn.source} ${data.frozenIn.what}`
    : "";
  return `Main thread frozen ${data.durationIsLowerBound ? "≥" : ""}${secs}s (${data.ended}) — ${at} — ${who}${task}`;
}
