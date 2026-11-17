import type { StallMemory, StallStacks } from "./tab-evidence";

// What a sampled window is called in the prose: a freeze the watchdog saw, an
// interaction's own time (handlers → paint), or a long frame under the stall
// bar that no interaction claimed (a `main-thread` slow-op).
const SUBJECT = {
  stall: {
    heap: "around the stall",
    title: "inside the stall",
    window: "through the freeze",
    truncated: "before the stall ended",
    noJs: "the freeze was the browser's own work (style, layout, paint, GC), the thread starved of CPU, or JS the profiler may not show — the heap below tells a collection apart.",
  },
  interaction: {
    heap: "around the interaction",
    title: "inside the interaction's own time",
    window: "from its handlers to the next paint",
    truncated: "before the interaction ended",
    noJs: "the time was the browser's own work (style, layout, paint, GC), the thread starved of CPU, or JS the profiler may not show.",
  },
  frame: {
    heap: "around the frame",
    title: "inside the long frame",
    window: "through the frame",
    truncated: "before the frame ended",
    noJs: "the frame was the browser's own work (style, layout, paint, GC), the thread starved of CPU, or JS the profiler may not show — the heap below tells a collection apart.",
  },
} as const;

/** Which window the evidence covers, as the prose names it. */
export type EvidenceSubject = keyof typeof SUBJECT;

/**
 * What the tab's sampling profiler caught underneath the long frames' entry
 * points, over a window of `windowMs` — the markdown section a stall, a
 * slow-interaction or a `main-thread` slow-op task carries.
 */
export function stacksSection(
  st: StallStacks,
  windowMs: number,
  subject: EvidenceSubject,
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

/** The tab's JS heap just before and right after the window. */
export function memorySection(
  m: StallMemory,
  subject: EvidenceSubject,
): string[] {
  const lines = [`**JS heap ${SUBJECT[subject].heap}**`];
  if (m.kind === "unavailable") {
    lines.push(`Not available: ${m.reason}.`);
    return lines;
  }
  const before =
    m.beforeMb === null
      ? "no reading before it"
      : `${m.beforeMb} MB${m.beforeAgoMs !== null && m.beforeAgoMs > 1500 ? ` (${(m.beforeAgoMs / 1000).toFixed(1)} s before it began)` : ""}`;
  lines.push(
    `In use before: **${before}** · after: **${m.afterMb} MB** · heap limit: **${m.limitMb} MB**.`,
  );
  const peak = Math.max(m.beforeMb ?? 0, m.afterMb);
  if (peak >= m.limitMb * 0.75)
    lines.push(
      `The heap was at ${Math.round((peak / m.limitMb) * 100)}% of its limit: V8 collecting garbage over and over near its ceiling stops the thread with no JS on the stack. Find what holds the memory (a leak growing over the visit, or one huge allocation), not the task it froze in.`,
    );
  else
    lines.push(
      "Far from its limit: not a collection near the ceiling. Time with no visible JS was then the renderer not scheduled (the machine short of CPU, or swapping), or JS the profiler may not show.",
    );
  return lines;
}
