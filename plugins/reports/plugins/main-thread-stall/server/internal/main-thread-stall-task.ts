import type { ReportRow } from "@plugins/reports/server";
import {
  MainThreadStallPayloadSchema,
  mainThreadStallSummary,
  type MainThreadStallPayload,
  type StallFrame,
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

function renderDescription(row: ReportRow, d: MainThreadStallPayload): string {
  const lines: string[] = [];
  lines.push(
    `A browser tab's **main thread stopped answering for ${d.durationIsLowerBound ? "at least " : ""}${(d.durationMs / 1000).toFixed(1)} s** while it was visible: the UI was frozen — no input, no paint. Ended: **${d.ended}** (${ENDED[d.ended]}).`,
  );
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
    "Reproduce on the route above and record it (Debug → Render Profiler, or the Performance panel). An attributed function is where to start; an unattributed `gone` stall with 0 frames is a synchronous loop — look at what mounted or updated right before (breadcrumbs, `logs/live-state.jsonl` for this tab). The slow-op `main-thread` row for this route shows how often it happens below the 5 s report bar.",
  );
  return lines.join("\n");
}
