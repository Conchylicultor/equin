import type { ReportRow } from "@plugins/reports/server";
import {
  dominantLayer,
  interactionTargetLabel,
  SlowInteractionPayloadSchema,
  slowInteractionSummary,
  type SlowInteractionPayload,
} from "../../core";

// A slow control is a standing bug, not news each time it is clicked.
export const SLOW_INTERACTION_NOTIF_COOLDOWN_MS = 30 * 60 * 1000;

// Where to look, by the layer most of the time went to.
const LAYER_HINTS: Record<ReturnType<typeof dominantLayer>["layer"], string> = {
  "forced style/layout":
    "A script read layout (getBoundingClientRect, offsetWidth, scrollTop, getComputedStyle…) after the DOM was written, so the browser recalculated style and layout synchronously inside it — typically a layout effect or a ref callback in React's commit, or a ResizeObserver / measuring hook reacting to the change. Find the read in the `forcedBy` function; move it before the write, batch it into one read, or make the style change cheaper (fewer elements restyled: a class toggled high in the tree restyles everything below it).",
  script:
    "JavaScript ran for most of it: event handlers, React render and commit, effects. Profile the click (Debug → Render Profiler, or the Performance panel) starting from the top function, and look for work that does not need to happen before the next paint.",
  "style/layout":
    "The frame's own style and layout pass was the cost: the change touched a large subtree (a class or theme change high in the tree, a remount of a big pane). Reduce what the change restyles, or what mounts at once.",
  other:
    "No long frame accounts for most of it: paint and compositing (large or many layers, filters, shadows), or the thread was busy with work under 50 ms per task. Record it in the Performance panel.",
};

export function renderSlowInteractionTask(row: ReportRow): {
  title: string;
  description: string;
} {
  // Validated by the schema at ingest: a failure here is a corrupted row.
  const d = SlowInteractionPayloadSchema.parse(row.data);
  const raw = `${row.noise ? "[noise] " : ""}[slow-interaction] ${slowInteractionSummary(d)}`;
  return {
    title: raw.length > 120 ? `${raw.slice(0, 117)}...` : raw,
    description: renderDescription(row, d),
  };
}

function renderDescription(row: ReportRow, d: SlowInteractionPayload): string {
  const t = d.target;
  const b = d.breakdown;
  const top = dominantLayer(b);
  const lines: string[] = [];
  lines.push(
    `A user interaction took **${d.durationMs} ms from input to the next paint** — the delay the user felt between their ${t.kind === "key" ? "key press" : "click"} and the screen answering (Event Timing; above 200 ms is felt, above 500 ms is poor).${d.pageCount > 1 ? ` Its target had **${d.pageCount}** interactions of ≥ 300 ms in that page load.` : ""}`,
  );
  lines.push("");
  lines.push("**What was interacted with**");
  lines.push(`- **Interaction:** ${interactionTargetLabel(t)}`);
  lines.push(
    `- **Element:** \`${t.element}\`${t.key ? ` (key \`${t.key}\`)` : ""}`,
  );
  lines.push(
    `- **Contribution:** ${t.contribution ? `\`${t.contribution}\`` : "—"}`,
  );
  lines.push(`- **Pane:** ${t.pane ? `\`${t.pane}\`` : "—"}`);
  lines.push(`- **Component:** ${t.owner ? `\`${t.owner}\`` : "—"}`);
  lines.push(`- **Event:** \`${d.eventType}\``);
  lines.push("");
  lines.push("**Where it went**");
  lines.push(
    `Event Timing phases: input delay ${d.inputDelayMs} ms (the thread was busy before the handlers could run) · event handlers ${d.processingMs} ms · presentation ${d.presentationDelayMs} ms (handlers' end → paint: render, commit, effects, style, layout, paint).`,
  );
  lines.push("");
  lines.push(
    "Long Animation Frames inside it (each script clipped to the interaction):",
  );
  lines.push(`- **script:** ${b.scriptMs} ms`);
  lines.push(
    `- **forced style/layout:** ${b.forcedStyleLayoutMs} ms${d.forcedBy ? ` — most by \`${d.forcedBy}\`` : ""}`,
  );
  lines.push(
    `- **style/layout (the frame's own pass):** ${b.styleLayoutMs} ms`,
  );
  lines.push(`- **other (paint, compositing, short tasks):** ${b.otherMs} ms`);
  lines.push("");
  lines.push(
    `**Most of it is ${top.layer} (${top.ms} ms).** ${LAYER_HINTS[top.layer]}`,
  );
  if (d.topFunction) lines.push(`Top function: \`${d.topFunction}\`.`);
  if (d.frames.length > 0) {
    lines.push("");
    lines.push("**Long frames (oldest first), their longest scripts:**");
    for (const f of d.frames) {
      const offset = f.startedAt - d.startedAt;
      lines.push(
        `- ${offset < 0 ? "−" : "+"}${Math.abs(offset)} ms — ${f.durationMs} ms (blocking ${f.blockingDurationMs} ms${f.styleAndLayoutStartMs !== null ? `, style/layout from +${f.styleAndLayoutStartMs} ms` : ""})`,
      );
      for (const s of f.scripts)
        lines.push(
          `  - \`${s.sourceFunctionName || "(anonymous)"}\` — ${s.invokerType} \`${s.invoker}\`, ${s.durationMs} ms (forced style/layout ${s.forcedStyleAndLayoutDurationMs} ms) @ ${s.sourceURL}:${s.sourceCharPosition}`,
        );
    }
  } else {
    lines.push("");
    lines.push(
      "No long animation frame (≥ 50 ms) overlapped it: the time was spread over short tasks, or spent in paint and compositing.",
    );
  }
  lines.push("");
  lines.push("**Where (context — not the identity)**");
  lines.push(
    `- **App:** \`${d.app ?? "?"}\` · **Route pattern:** \`${d.routePattern}\``,
  );
  lines.push(`- **URL:** ${d.url}`);
  lines.push(`- **When:** ${new Date(d.startedAt).toISOString()}`);
  lines.push("");
  lines.push("**Report**");
  lines.push(`- **Worktree:** ${row.worktree}`);
  lines.push(`- **Fingerprint:** ${row.fingerprint}`);
  lines.push(`- **Count:** ${row.count}`);
  lines.push(`- **First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`- **Last seen:** ${row.lastSeenAt.toISOString()}`);
  lines.push("");
  lines.push("**How to investigate**");
  lines.push(
    "Reproduce the interaction and record it (Performance panel: the interaction track names it; or Debug → Render Profiler for React commits). Every occurrence ≥ 200 ms is on Debug → Slow Events as the `interaction` op of this target (count, per-route callers, the variant naming what forced layout) and on the Timeline at its instant.",
  );
  return lines.join("\n");
}
