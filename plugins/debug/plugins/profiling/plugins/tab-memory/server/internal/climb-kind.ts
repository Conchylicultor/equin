import { ReportKind, type ReportRow } from "@plugins/reports/server";
import {
  TAB_MEMORY_CLIMB_KIND,
  TabMemoryClimbSchema,
  type ClimbPage,
  type TabMemoryClimb,
  type TabMemoryGrowth,
} from "../../core";

/**
 * A standing condition: the watch re-files it every tick while the renderer
 * stays past the bar (that is how its count reaches the investigations
 * automation's recurrence bar). The bell re-rings at most every 6 h.
 */
const NOTIF_COOLDOWN_MS = 6 * 60 * 60_000;

/**
 * `tab-memory-climb`: one Chrome renderer of the user's Chrome whose memory
 * floor is too large or climbing. One report per renderer (by pid): its
 * count is how many watch ticks (10 min apart) found it past the bar, its
 * data the latest reading. Variant `error`: a tab past 3 GB keeps climbing
 * to 10+ GB and starves the machine — it is a defect to fix, and the default
 * Report investigations scope (errors only) must pick it up.
 */
export const tabMemoryClimbKind = ReportKind({
  kind: TAB_MEMORY_CLIMB_KIND,
  schema: TabMemoryClimbSchema,
  fingerprint: (d: TabMemoryClimb) =>
    `${TAB_MEMORY_CLIMB_KIND}:renderer:${d.pid}`,
  meta: {
    tag: "[tab-memory]",
    notif: "A browser tab's memory is climbing",
    variant: "error",
    notifCooldownMs: NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = TabMemoryClimbSchema.parse(row.data);
    return {
      title: `[tab-memory] Chrome renderer ${d.pid} at ${gb(d.floorNowMb)} — ${headline(d)}`,
      description: renderDescription(row, d),
    };
  },
});

const gb = (mb: number): string => `${(mb / 1024).toFixed(1)} GB`;
const time = (t: number): string =>
  new Date(t).toISOString().slice(0, 16) + "Z";

function headline(d: TabMemoryClimb): string {
  return d.trigger === "climbing" && d.riseMb !== null
    ? `+${gb(d.riseMb)} at ${d.riseMbPerHour} MB/h (${d.growth})`
    : `high (${d.growth})`;
}

const GROWTH_TEXT: Record<TabMemoryGrowth, string> = {
  "js-heap":
    "**JS heap.** A page's JS heap grew by a third or more of the renderer's climb: something in that page retains objects. Reproduce its route and in-app tabs and run the harness's `leak-test.ts` (three heap snapshots, survivors, retainer paths).",
  "canvas-images":
    "**Canvas / images.** A page's canvas backing stores + decoded images grew by a third or more of the climb: look for canvases or images created and never released (a hidden in-app tab keeps its DOM mounted).",
  dom: "**DOM.** A page's DOM node count climbed (≥ 10,000 more, ≥ 1.5×): a list or log appended to without bound, or subtrees never unmounted.",
  native:
    "**Native.** Pages sampled themselves through the window, but neither their JS heap, DOM nor canvas/images explain the growth: native memory the page cannot see (decoded audio, GPU tiles, network buffers, the inspector…). Measure it per allocator with `e2e/clean-soak.ts` on the candidate routes / in-app tabs.",
  unattributed:
    "**Unattributed.** No equin page sampled itself through the window: the tab may not be equin, or ran a build without the tab-memory recorder.",
};

function pageLine(p: ClimbPage): string {
  const heap =
    p.jsHeapStartMb === null || p.jsHeapNowMb === null
      ? "JS heap n/a"
      : `JS heap ${p.jsHeapStartMb} → ${p.jsHeapNowMb} MB`;
  const tabs = p.inAppTabs
    .map(
      (t) =>
        `${t.focused ? "**" : ""}${t.appId} \`${t.path}\`${t.focused ? "**" : ""}`,
    )
    .join(", ");
  const more =
    p.inAppTabsTotal > p.inAppTabs.length
      ? ` … +${p.inAppTabsTotal - p.inAppTabs.length} more`
      : "";
  return [
    `- \`${p.host}\` \`${p.route}\` (app ${p.focusedAppId ?? "none"}, worktree ${p.worktree}) — ${p.alive ? "open" : "closed"}, ${p.visible ? "visible" : "hidden"}, loaded ${time(p.pageStartedAt)}, last sample ${time(p.lastSampledAt)}`,
    `  - ${heap}; DOM ${p.domStart.toLocaleString("en-US")} → ${p.domNow.toLocaleString("en-US")} nodes; canvas + images ${p.canvasImagesStartMb} → ${p.canvasImagesNowMb} MB`,
    `  - ${p.inAppTabsTotal} in-app tabs held: ${tabs || "none"}${more}`,
    `  - page id \`${p.pageId}\``,
  ].join("\n");
}

function renderDescription(row: ReportRow, d: TabMemoryClimb): string {
  const lines: string[] = [];
  lines.push(
    d.trigger === "climbing"
      ? `A Chrome renderer of the user's Chrome (pid **${d.pid}**) is climbing: its memory floor (lowest footprint over the last 30 minutes, immune to GC sawtooth) is **${d.floorNowMb} MB**, up **${d.riseMb} MB** from ${d.baselineMb} MB at ${time(d.windowStart)} — **${d.riseMbPerHour} MB/h**.`
      : `A Chrome renderer of the user's Chrome (pid **${d.pid}**) is too large: its memory floor (lowest footprint over the last 30 minutes) is **${d.floorNowMb} MB**, past the ${d.thresholds.highFloorMb} MB bar.`,
  );
  lines.push("");
  lines.push(`**What grew:** ${GROWTH_TEXT[d.growth]}`);
  lines.push("");
  lines.push(
    `**Peak (6 h):** ${d.peakMb} MB · **Window judged:** ${time(d.windowStart)} → ${time(d.windowEnd)}`,
  );
  lines.push("");
  lines.push("**Growth curve** (20-minute bins, min – max MB):");
  lines.push("");
  lines.push(
    d.curve
      .map((p) => `${time(p.t).slice(11, 16)} ${p.minMb}–${p.maxMb}`)
      .join(" · ") || "(none)",
  );
  lines.push("");
  lines.push(
    "**Candidate pages** — a page cannot learn its renderer's pid, so these are the equin pages that sampled themselves through the window (joined by time): the page behind **What grew** first, then open pages, then the ones whose figures grew most:",
  );
  lines.push("");
  lines.push(d.pages.length ? d.pages.map(pageLine).join("\n") : "- (none)");
  lines.push("");
  lines.push(
    "Read it on one time axis in **Debug → Tab memory** (`/debug/tab-memory`): the renderer by pid, each page's JS heap, and the pages table. Raw data: the main checkout's `health-owners` log (renderers by pid) and each worktree's `tab-memory` log (page samples) — `debug` skill for where logs live. Method and past findings: `plugins/debug/plugins/profiling/plugins/tab-memory/CLAUDE.md`.",
  );
  lines.push("");
  lines.push(
    `**Bars:** too large ≥ ${d.thresholds.highFloorMb} MB floor; climbing = floor ≥ ${d.thresholds.climbFloorMb} MB and ≥ ${d.thresholds.climbRiseMb} MB above the 3 h low (Settings → Config → tab-memory-climb).`,
  );
  lines.push("");
  lines.push(
    "**A fix lands only on reload**: the renderer keeps what it holds until its tab is reloaded or closed, so after the fix is deployed this report re-fires (and reads as Regressed) until the user reloads that tab — say so in the outcome.",
  );
  lines.push("");
  lines.push(`**Ticks past the bar:** ${row.count}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
