import type { StallStacks } from "../../core";

// What a sampled window is called in the prose: a freeze the watchdog saw, or
// an interaction's own time (handlers → paint).
const SUBJECT = {
  stall: {
    title: "inside the stall",
    window: "through the freeze",
    truncated: "before the stall ended",
    noJs: "the freeze was the browser's own work (style, layout, paint, GC), the thread starved of CPU, or JS the profiler may not show — the heap below tells a collection apart.",
  },
  interaction: {
    title: "inside the interaction's own time",
    window: "from its handlers to the next paint",
    truncated: "before the interaction ended",
    noJs: "the time was the browser's own work (style, layout, paint, GC), the thread starved of CPU, or JS the profiler may not show.",
  },
} as const;

/**
 * What the tab's sampling profiler caught underneath the long frames' entry
 * points, over a window of `windowMs` — the markdown section a stall or a
 * slow-interaction task carries.
 */
export function stacksSection(
  st: StallStacks,
  windowMs: number,
  subject: keyof typeof SUBJECT,
): string[] {
  const w = SUBJECT[subject];
  const lines = [`**Sampled stacks (JS Self-Profiling, ${w.title})**`];
  if (st.kind === "unavailable") {
    lines.push(`Not available: ${st.reason}.`);
    return lines;
  }
  const secs = (ms: number): string => (ms / 1000).toFixed(1);
  lines.push(
    `The tab's own profiler sampled every ~${st.sampleIntervalMs} ms ${w.window}: **${secs(st.sampledMs)} s** sampled of ${secs(windowMs)} s, ${secs(st.noJsMs)} s of it with no JS on the stack (style, layout, paint, GC, native work — or JS from a script the profiler may not show: cross-origin without CORS, an extension, eval'd code).${st.sampledMs < windowMs * 0.8 ? ` The sampler itself missed ${secs(windowMs - st.sampledMs)} s (gaps of several intervals): the whole renderer was short of CPU or memory, not only the main thread.` : ""}${st.truncated ? ` **Truncated**: the profiler's buffer filled ${w.truncated}; the stacks cover its start only.` : ""}`,
  );
  if (st.topSelf.length > 0) {
    lines.push("");
    lines.push("Heaviest functions (self time — the innermost frame):");
    for (const f of st.topSelf) lines.push(`- ${f.ms} ms — \`${f.frame}\``);
  }
  st.stacks.forEach((s, i) => {
    lines.push("");
    lines.push(
      `Stack ${i + 1} — ${s.ms} ms (${s.samples} samples), innermost first:`,
    );
    lines.push("```");
    lines.push(...s.frames);
    lines.push("```");
  });
  if (st.stacks.length === 0 && st.sampledMs > 0)
    lines.push(`No visible JS in any sample: ${w.noJs}`);
  return lines;
}
