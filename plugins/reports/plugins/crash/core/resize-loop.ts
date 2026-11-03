import { z } from "zod";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";

// What a "ResizeObserver loop completed with undelivered notifications" crash
// carries instead of the stack the browser never gives it: the observer
// callbacks of the rendering step that raised it, and of the next one (which
// delivers what was held back). Traced on the page by
// primitives/dom/element-size/resize-loop-trace, described here.

export const RESIZE_LOOP_TARGETS_MAX = 8;
export const RESIZE_LOOP_OBSERVATIONS_MAX = 20;

const ResizeLoopTargetSchema = z.object({
  // `tag#id.class.class.class` — the element itself.
  element: z.string(),
  // The nearest build-stamped component (`Name@file:line`) and source
  // (`file:line`) above it — who drew it.
  owner: z.string().nullable(),
  source: z.string().nullable(),
  // Ancestors to the document root. The loop holds back a notification for
  // an element at or above the depth of the ones just delivered, so the
  // shallowest targets are the ones to look at.
  depth: z.number().int(),
  width: z.number(),
  height: z.number(),
  // False when the element had left the document by the time it was described.
  connected: z.boolean(),
});

const ResizeLoopObservationSchema = z.object({
  // The stack frames that created the observer — a library's observer, or
  // the element-size primitive (then the targets' owner is the caller).
  site: z.string().nullable(),
  targets: cappedList(ResizeLoopTargetSchema, { max: RESIZE_LOOP_TARGETS_MAX }),
  omittedTargets: z.number().int(),
});

export const ResizeLoopTraceSchema = z.object({
  pass: cappedList(ResizeLoopObservationSchema, {
    max: RESIZE_LOOP_OBSERVATIONS_MAX,
  }),
  omittedPass: z.number().int(),
  deferred: cappedList(ResizeLoopObservationSchema, {
    max: RESIZE_LOOP_OBSERVATIONS_MAX,
  }),
  omittedDeferred: z.number().int(),
});
export type ResizeLoopTrace = z.infer<typeof ResizeLoopTraceSchema>;
type ResizeLoopObservation = z.infer<typeof ResizeLoopObservationSchema>;

/** The trace as markdown, for the crash task an agent investigates. */
export function formatResizeLoopTrace(trace: ResizeLoopTrace): string {
  const lines = [
    "**ResizeObserver trace**",
    "",
    "A callback in the first list resized an element at or above the depth of the elements just delivered; that element's notification was held back to the next frame (second list — look at its shallowest targets). `site` is where the observer was created.",
    "",
    "_Observer callbacks in the step that raised it:_",
    ...observations(trace.pass, trace.omittedPass),
    "",
    "_Delivered on the next frame (the held-back notifications):_",
    ...observations(trace.deferred, trace.omittedDeferred),
  ];
  return lines.join("\n");
}

function observations(
  list: readonly ResizeLoopObservation[],
  omitted: number,
): string[] {
  if (list.length === 0) return ["- (none)"];
  const lines: string[] = [];
  for (const o of list) {
    lines.push(
      `- site: ${o.site ? o.site.split("\n").join(" ← ") : "unknown"}`,
    );
    for (const t of o.targets) {
      const who = [t.owner, t.source].filter(Boolean).join(" · ");
      const gone = t.connected ? "" : " (detached)";
      lines.push(
        `  - depth ${t.depth} \`${t.element}\` ${Math.round(t.width)}×${Math.round(t.height)}${gone}${who ? ` — ${who}` : ""}`,
      );
    }
    if (o.omittedTargets > 0) lines.push(`  - … ${o.omittedTargets} more`);
  }
  if (omitted > 0) lines.push(`- … ${omitted} more callbacks`);
  return lines;
}
