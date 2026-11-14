import type { ReportRow } from "@plugins/reports/server";
import {
  dominantLayer,
  interactionTargetLabel,
  MainThreadStallPayloadSchema,
  mainThreadStallSummary,
  type MainThreadStallPayload,
  type StallFrame,
  type TaskMark,
} from "../../core";

// A recurring freeze on the same screen is a standing bug, not news each time:
// re-alert the bell at most every 30 min (as the server event-loop stall does).
export const MAIN_THREAD_STALL_NOTIF_COOLDOWN_MS = 30 * 60 * 1000;

const ENDED: Record<MainThreadStallPayload["ended"], string> = {
  recovered: "the tab answered again on its own",
  gone: "the tab was reloaded, closed or killed while still frozen",
  unknown:
    "the watchdog itself went away with the stall still open (last tab closed, browser quit) — filed when it next started; the duration is a lower bound",
};

export function renderMainThreadStallTask(row: ReportRow): {
  title: string;
  description: string;
} {
  // Validated by the schema at ingest: a failure here is a corrupted row.
  const d = MainThreadStallPayloadSchema.parse(row.data);
  const raw = `${row.noise ? "[noise] " : ""}[main-thread-stall] ${mainThreadStallSummary(d)}`;
  return {
    title: raw.length > 120 ? `${raw.slice(0, 117)}...` : raw,
    description: renderDescription(row, d),
  };
}

/** One frame, timed relative to the stall's start so its distance from the freeze is plain. */
function frameLine(f: StallFrame, stallStartedAt: number): string {
  const top = f.scripts[0];
  const what = top
    ? `\`${top.sourceFunctionName || "(anonymous)"}\` via ${top.invokerType} \`${top.invoker}\` (${top.durationMs} ms script, ${top.forcedStyleAndLayoutDurationMs} ms forced layout) @ ${top.sourceURL}:${top.sourceCharPosition}`
    : "no script attributed";
  const offset = (f.startedAt - stallStartedAt) / 1000;
  const at = `${offset < 0 ? "−" : "+"}${Math.abs(offset).toFixed(1)} s`;
  return `${at} (${new Date(f.startedAt).toISOString()}) — ${f.durationMs} ms (blocking ${f.blockingDurationMs} ms): ${what}`;
}

/** One task mark, timed relative to the stall's start. */
function markLine(k: TaskMark, stallStartedAt: number): string {
  const offset = (k.at - stallStartedAt) / 1000;
  const at = `${offset < 0 ? "−" : "+"}${Math.abs(offset).toFixed(1)} s`;
  return `${at} — \`${k.source}\` \`${k.what}\` (${k.detail})`;
}

/** What the tab's sampling profiler caught underneath the entry point. */
function stacksSection(d: MainThreadStallPayload): string[] {
  const st = d.stacks;
  const lines = ["**Sampled stacks (JS Self-Profiling, inside the stall)**"];
  if (st.kind === "unavailable") {
    lines.push(`Not available: ${st.reason}.`);
    return lines;
  }
  const secs = (ms: number): string => (ms / 1000).toFixed(1);
  lines.push(
    `The stalled tab's own profiler sampled every ~${st.sampleIntervalMs} ms through the freeze: **${secs(st.sampledMs)} s** sampled of ${secs(d.durationMs)} s, ${secs(st.noJsMs)} s of it with no JS on the stack (style, layout, paint, GC — or the thread not scheduled).${st.truncated ? " **Truncated**: the profiler's buffer filled before the stall ended; the stacks cover its start only." : ""}`,
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
    lines.push(
      "No JS ran in any sample: the freeze was the browser's own work (style, layout, paint, GC) or the thread starved of CPU.",
    );
  return lines;
}

function renderDescription(row: ReportRow, d: MainThreadStallPayload): string {
  const lines: string[] = [];
  lines.push(
    `A browser tab's **main thread stopped answering for ${d.durationIsLowerBound ? "at least " : ""}${(d.durationMs / 1000).toFixed(1)} s** while it was visible: the UI was frozen — no input, no paint. Ended: **${d.ended}** (${ENDED[d.ended]}).`,
  );
  if (d.interaction) {
    const i = d.interaction;
    const t = i.target;
    const b = i.breakdown;
    const top = dominantLayer(b);
    const offset = ((d.startedAt - i.startedAt) / 1000).toFixed(1);
    lines.push("");
    lines.push("**What was clicked — the freeze started from it**");
    lines.push(
      `The tab told the watchdog, as it dispatched the \`${i.eventType}\` and before any handler ran, that a person had interacted with **${interactionTargetLabel(t)}**; that interaction never reached its next paint before the thread went silent (${offset} s later). Its handlers — or the render, commit and effects they led to — are the freeze. This report is keyed by that control: the same control freezing again, on any screen, lands here.`,
    );
    lines.push(`- **Element:** \`${t.element}\``);
    if (t.key) lines.push(`- **Key:** \`${t.key}\``);
    lines.push(`- **Contribution:** \`${t.contribution ?? "-"}\``);
    lines.push(`- **Pane:** \`${t.pane ?? "-"}\``);
    lines.push(`- **Component:** \`${t.owner ?? "-"}\``);
    lines.push(
      `- **Where the time went** (input → end of the freeze, from the long frames the watchdog holds): script ${b.scriptMs} ms · forced style/layout ${b.forcedStyleLayoutMs} ms${i.forcedBy ? ` (forced by \`${i.forcedBy}\`)` : ""} · style/layout ${b.styleLayoutMs} ms · other ${b.otherMs} ms — mostly **${top.layer}**.${d.stallFrame || d.during.length > 0 ? "" : " No long frame came back from the frozen tab, so all of it is `other`."}`,
    );
  }
  lines.push("");
  lines.push("**Where**");
  lines.push(`- **App:** \`${d.app ?? "?"}\``);
  lines.push(`- **Route pattern:** \`${d.routePattern}\``);
  lines.push(`- **URL:** ${d.url}`);
  lines.push(`- **Tab:** \`${d.tabId}\`${d.focused ? " (focused)" : ""}`);
  lines.push(
    `- **When:** ${new Date(d.startedAt).toISOString()} → ${new Date(d.endedAt).toISOString()}`,
  );
  lines.push(`- **Detector:** ${d.detector}`);
  lines.push("");
  lines.push("**What ran**");
  if (d.stallFrame) {
    lines.push(
      "The browser's own Long Animation Frame entry for the frozen frame (the definitive attribution), longest scripts first:",
    );
    for (const s of d.stallFrame.scripts)
      lines.push(
        `- \`${s.sourceFunctionName || "(anonymous)"}\` — ${s.invokerType} \`${s.invoker}\`, ${s.durationMs} ms (forced style/layout ${s.forcedStyleAndLayoutDurationMs} ms, paused ${s.pauseDurationMs} ms) @ ${s.sourceURL}:${s.sourceCharPosition}`,
      );
    if (d.stallFrame.scripts.length === 0)
      lines.push(
        "- (the frame named no script: style/layout/paint, or a browser-internal task)",
      );
  } else {
    const coveredMs = d.during.reduce((sum, f) => sum + f.durationMs, 0);
    if (d.during.length > 0) {
      lines.push(
        `No single Long Animation Frame entry covers the freeze. **${d.framesDuring}** long frame(s) ran inside it; the longest${d.framesDuring > d.during.length ? ` ${d.during.length}` : ""}, timed from the stall's start, cover ${coveredMs} ms of the ${(d.durationMs / 1000).toFixed(1)} s:`,
      );
      for (const f of d.during) lines.push(`- ${frameLine(f, d.startedAt)}`);
    } else if (d.framesDuring > 0) {
      lines.push(
        `**${d.framesDuring}** long frame(s) ran inside the stall (not kept: filed before a stall recorded its own frames).`,
      );
    }
    if (d.ended === "recovered" && coveredMs < d.durationMs / 2) {
      lines.push(
        `${d.framesDuring > 0 ? "Most of the silence" : "The silence"} ran **no long task** — LoAF records every main-thread task ≥ 50 ms, and the tab recovered on its own. The thread was most likely **not scheduled** (the renderer starved of CPU — e.g. a backgrounded headless agent browser on a loaded host), not running app code${d.during.length > 0 ? ": the frames above are not the freeze's cause" : ""}. Check host load at that instant before reading app code.`,
      );
    } else if (d.during.length === 0) {
      lines.push(
        `No Long Animation Frame entry from inside the stall: the tab never finished the frozen frame (${d.ended}).${d.framesDuring === 0 ? " No frame completed during it: one task never yielded (an endless or very long synchronous loop)." : ""}`,
      );
    }
  }
  lines.push("");
  lines.push(...stacksSection(d));
  lines.push("");
  lines.push("**The task it froze in**");
  if (d.frozenIn) {
    lines.push(
      `The tab said, as it began it, that it was running **\`${d.frozenIn.source}\` \`${d.frozenIn.what}\`** (${d.frozenIn.detail}) — a task it began and never ended: it was still inside it, silent, when the stall opened${d.framesDuring === 0 ? "; no frame completed inside the stall, so it never yielded" : ""}. Start there: what that task runs (its handler, the microtasks it queues — LoAF counts them in the entry point's script time).`,
    );
  } else if (d.marks.length > 0) {
    lines.push(
      "No marked task was open when the stall opened: the tab froze **outside every marked entry point** (`primitives/perfs/task-marks` lists them: live-state socket frames, the detector's own watchdog messages). The marks below are tasks that finished — not the freeze.",
    );
  } else {
    lines.push(
      "No task marks reached the watchdog (an in-tab fallback stall, a hidden tab, or filed before marks existed).",
    );
  }
  if (d.marks.length > 0) {
    lines.push("");
    lines.push(
      "**Task marks (the latest, oldest first)** — what the tab said it was starting, timed from the stall's start:",
    );
    for (const k of d.marks) lines.push(`- ${markLine(k, d.startedAt)}`);
  }
  if (d.frames.length > 0) {
    lines.push("");
    lines.push(
      "**Long frames before the stall (breadcrumbs, oldest first)** — what the tab did earlier, timed from the stall's start. Not the freeze itself:",
    );
    // Sorted here too: reports filed before the watchdog sorted them are in arrival order.
    for (const f of [...d.frames].sort((a, b) => a.startedAt - b.startedAt))
      lines.push(`- ${frameLine(f, d.startedAt)}`);
  }
  if (d.cohort.length > 0) {
    lines.push("");
    lines.push(
      `**Cohort** — ${d.cohort.length} other tab(s) froze at the same moment (same renderer process): victims, not causes.`,
    );
    for (const t of d.cohort)
      lines.push(
        `- \`${t.app ?? "?"}\` \`${t.routePattern}\` — ${t.url}${t.visible ? "" : " (hidden)"}`,
      );
  }
  lines.push("");
  lines.push("**Report**");
  lines.push(`- **Worktree:** ${row.worktree}`);
  lines.push(`- **Fingerprint:** ${row.fingerprint}`);
  lines.push(`- **Count:** ${row.count}`);
  lines.push(`- **First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`- **Last seen:** ${row.lastSeenAt.toISOString()}`);
  if (row.userAgent) lines.push(`- **User-Agent:** ${row.userAgent}`);
  lines.push("");
  lines.push("**How to investigate**");
  lines.push(
    "Start from the sampled stacks above when there are any: they are what ran underneath the entry point. Otherwise reproduce on the route above and record it (Debug → Render Profiler, or the Performance panel). An attributed function is where to start; an unattributed `gone` stall with 0 frames is a synchronous loop — look at what mounted or updated right before (breadcrumbs, `logs/live-state.jsonl` for this tab). The slow-op `main-thread` row for this route shows how often it happens below the 5 s report bar.",
  );
  return lines.join("\n");
}
