import { z } from "zod";
import {
  dominantLayer,
  InteractionBreakdownSchema,
  interactionTargetKey,
  interactionTargetLabel,
  InteractionTargetSchema,
} from "./interaction-target";
import { StallStacksSchema } from "@plugins/reports/plugins/main-thread-stall/plugins/tab-evidence/core";
import { StallFrameSchema } from "./main-thread-stall-kind";

// The `slow-interaction` report payload: a click, tap or key press whose next
// paint came late — the delay the user felt, measured by the browser's Event
// Timing API and split by the Long Animation Frames that ran inside it. Filed
// by the tab itself (it was never frozen long enough to need the watchdog).

export const SlowInteractionPayloadSchema = z.object({
  target: InteractionTargetSchema,
  // The longest Event Timing entry of the interaction (pointerdown, click, …).
  eventType: z.string(),
  // Epoch ms of the input, and how long until the next paint (Event Timing's
  // `duration`, rounded by the browser to 8 ms).
  startedAt: z.number(),
  durationMs: z.number(),
  // Event Timing's three phases: waiting for the thread (input delay), the
  // event handlers themselves (processing), and handlers' end → next paint
  // (presentation — render, commit, effects, style, layout, paint).
  inputDelayMs: z.number(),
  processingMs: z.number(),
  presentationDelayMs: z.number(),
  breakdown: InteractionBreakdownSchema,
  // The script with the most time inside the interaction, and the script that
  // forced the most style/layout — `function (invoker)`; null when none did.
  topFunction: z.string().nullable(),
  forcedBy: z.string().nullable(),
  // The long animation frames inside it (oldest first, capped).
  frames: z.array(StallFrameSchema),
  // How many interactions of ≥ 300 ms this target had in this page load, this
  // one included — why a report under the severe bar was filed.
  pageCount: z.number(),
  // Where it happened (context, never identity).
  tabId: z.string(),
  app: z.string().nullable(),
  routePattern: z.string(),
  url: z.string(),
  // Where the interaction TOOK the tab, read once its paint was judged: the
  // route it landed on, or null when it stayed on the route above. A click
  // that opens something is paid for by what it opened (a session row that
  // restores a long page beside its conversation costs the page, not the
  // row), which the starting route alone does not name. Context, never
  // identity.
  landed: z
    .object({ routePattern: z.string(), url: z.string() })
    .nullable()
    .default(null),
  // The JS stacks the tab's sampling profiler caught inside the interaction's
  // own time (handlers → paint): what ran underneath the long frames' entry
  // points (a React root's `onclick` names nothing). Added by the tab when it
  // REPORTS one (not for every recorded slow-op). Evidence only: never part
  // of the fingerprint or summary.
  stacks: StallStacksSchema.default({
    kind: "unavailable",
    reason: "filed before slow-interaction reports carried sampled stacks",
  }),
});
export type SlowInteractionPayload = z.infer<
  typeof SlowInteractionPayloadSchema
>;

/**
 * A slow interaction as the interaction watch measures it: everything but
 * `stacks`, which the tab adds from its profiler only when it reports one. It
 * is also all the fingerprint and summary may read.
 */
export type SlowInteractionDraft = Omit<SlowInteractionPayload, "stacks">;

/**
 * What was interacted with — kind, key class, element, contribution, pane and
 * owner. No app, route, url, durations or tab: the same slow control is one row
 * whose `count` grows, wherever it is drawn.
 */
export function slowInteractionFingerprint(d: SlowInteractionDraft): string {
  return `slow-interaction:${interactionTargetKey(d.target)}`;
}

/** The one-line summary used as the report message and the task title stem. */
export function slowInteractionSummary(d: SlowInteractionDraft): string {
  const top = dominantLayer(d.breakdown);
  const who =
    d.forcedBy && top.layer === "forced style/layout"
      ? d.forcedBy
      : d.topFunction;
  return `Slow interaction ${d.durationMs} ms — ${interactionTargetLabel(d.target)} — ${top.layer} ${top.ms} ms${who ? ` (${who})` : ""}`;
}
