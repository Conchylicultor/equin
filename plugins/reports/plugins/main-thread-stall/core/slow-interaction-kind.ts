import { z } from "zod";
import { StallFrameSchema } from "./main-thread-stall-kind";

// The `slow-interaction` report payload: a click, tap or key press whose next
// paint came late — the delay the user felt, measured by the browser's Event
// Timing API and split by the Long Animation Frames that ran inside it. Filed
// by the tab itself (it was never frozen long enough to need the watchdog).

// What was interacted with, resolved when the event was dispatched (the node is
// often gone by the time its paint is measured: a slow switch remounts the very
// button). Never the app, route or url — the same control is one identity on
// every screen it is drawn on — and never user content: a name is read only
// from an aria-label or a button's own label, a key only as its class.
export const InteractionTargetSchema = z.object({
  // `click` (pointer: tap, click) or `key`.
  kind: z.enum(["click", "key"]),
  // The key class of a keyboard interaction (`Enter`, `Escape`, `ArrowDown`,
  // `Mod+K`, `char` for a printable key alone); null for a pointer one.
  key: z.string().nullable(),
  // The nearest interactive element (`button — Full screen`,
  // `div[role=tab] — Files`, `a`): ui-context's element descriptor.
  element: z.string(),
  // The innermost slot contribution around it (`plugin@slot`), when the
  // composition stamps contributions (the element picker's middleware).
  contribution: z.string().nullable(),
  // The innermost pane it sits in (`plugin#pane:<pane id>`), without position.
  pane: z.string().nullable(),
  // The composing component (`data-ui-owner`'s name, no file:line).
  owner: z.string().nullable(),
});
export type InteractionTarget = z.infer<typeof InteractionTargetSchema>;

// Where the interaction's time went: a partition of its duration, from the
// long animation frames inside it (each script clipped to the interaction).
export const InteractionBreakdownSchema = z.object({
  // JavaScript (event handlers, React render/commit, effects, observers) less
  // the style/layout it forced.
  scriptMs: z.number(),
  // Style and layout forced synchronously by a script reading layout after a
  // DOM write (`forcedStyleAndLayoutDuration`).
  forcedStyleLayoutMs: z.number(),
  // The frame's own style and layout pass, before paint.
  styleLayoutMs: z.number(),
  // The rest: paint, compositing, render steps outside scripts, or waiting —
  // time no long frame accounts for.
  otherMs: z.number(),
});
export type InteractionBreakdown = z.infer<typeof InteractionBreakdownSchema>;

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
});
export type SlowInteractionPayload = z.infer<
  typeof SlowInteractionPayloadSchema
>;

/** The target in one line: `click button — Full screen in apps-core#pane:x (Owner)`. */
export function interactionTargetLabel(t: InteractionTarget): string {
  const what = t.kind === "key" ? `key ${t.key ?? "?"} on` : "click";
  const where = t.contribution ?? t.pane;
  return (
    `${what} ${t.element}` +
    (where ? ` in ${where}` : "") +
    (t.owner ? ` (${t.owner})` : "")
  );
}

/**
 * What was interacted with — kind, key class, element, contribution, pane and
 * owner. No app, route, url, durations or tab: the same slow control is one row
 * whose `count` grows, wherever it is drawn.
 */
export function slowInteractionFingerprint(d: SlowInteractionPayload): string {
  const t = d.target;
  return `slow-interaction:${t.kind}${t.key ? `:${t.key}` : ""}|${t.contribution ?? "-"}|${t.pane ?? "-"}|${t.owner ?? "-"}|${t.element}`;
}

/** The layer most of the interaction went to, for one-line summaries. */
export function dominantLayer(b: InteractionBreakdown): {
  layer: "script" | "forced style/layout" | "style/layout" | "other";
  ms: number;
} {
  const layers = [
    { layer: "script", ms: b.scriptMs },
    { layer: "forced style/layout", ms: b.forcedStyleLayoutMs },
    { layer: "style/layout", ms: b.styleLayoutMs },
    { layer: "other", ms: b.otherMs },
  ] as const;
  return layers.reduce((a, c) => (c.ms > a.ms ? c : a));
}

/** The one-line summary used as the report message and the task title stem. */
export function slowInteractionSummary(d: SlowInteractionPayload): string {
  const top = dominantLayer(d.breakdown);
  const who =
    d.forcedBy && top.layer === "forced style/layout"
      ? d.forcedBy
      : d.topFunction;
  return `Slow interaction ${d.durationMs} ms — ${interactionTargetLabel(d.target)} — ${top.layer} ${top.ms} ms${who ? ` (${who})` : ""}`;
}
