import { z } from "zod";

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
  // Other tabs that froze with it (same renderer process): victims, not causes.
  cohort: z.array(StallTabSchema),
  // The longest-running script of `stallFrame` — or, without one, summed over
  // `during` — as `function (invoker)`; null when unattributed. THE
  // attribution grain of the fingerprint.
  topFunction: z.string().nullable(),
});
export type MainThreadStallPayload = z.infer<
  typeof MainThreadStallPayloadSchema
>;

/**
 * App + route pattern + the top attributed function (or `unattributed`). No
 * ids, durations or end kinds: the same freeze on the same screen is one row
 * whose `count` grows, and its `data` is the newest sighting.
 */
export function mainThreadStallFingerprint(
  data: MainThreadStallPayload,
): string {
  return `main-thread-stall:${data.app ?? "-"}|${data.routePattern}|${data.topFunction ?? "unattributed"}`;
}

/** The one-line summary used as the report message and the task title stem. */
export function mainThreadStallSummary(data: MainThreadStallPayload): string {
  const secs = (data.durationMs / 1000).toFixed(1);
  const at = `${data.app ?? "?"} ${data.routePattern}`;
  const who = data.topFunction ?? "unattributed";
  return `Main thread frozen ${data.durationIsLowerBound ? "≥" : ""}${secs}s (${data.ended}) — ${at} — ${who}`;
}
