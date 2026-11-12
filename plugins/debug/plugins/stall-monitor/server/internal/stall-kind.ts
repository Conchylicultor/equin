import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { traceDetailRoute } from "@plugins/debug/plugins/trace/plugins/engine/core";
import { StallPayloadSchema, type StallPayload } from "../../core";

// Re-alert the bell at most once per 30 min while the same stack keeps freezing
// the loop. A recurring freeze is a persistent condition (the same code stalls
// tick after tick, e.g. the Jul-7 ccusage transcript-parse over days), not a
// one-shot incident, so the cooldown re-surfaces it periodically without spamming.
const STALL_NOTIF_COOLDOWN_MS = 30 * 60 * 1000;

// The `event-loop-stall` report kind — the alert-funnel side of a stall, the twin
// of the `stall` trace evidence. Dedups on the dominant CALLER STACK
// (`event-loop-stall:<culpritStack>`), not the leaf: the hottest leaf can be a
// generic native frame (`JSON.parse [native]`) shared by many callers, so a
// leaf-keyed fingerprint would misattribute (see server/internal/culprit.ts).
// Variant `error`: a frozen backend is the most severe slow event.
export const stallMonitorKind = ReportKind({
  kind: "event-loop-stall",
  schema: StallPayloadSchema,
  fingerprint: (d: StallPayload) => `event-loop-stall:${d.culpritStack}`,
  meta: {
    tag: "[stall]",
    notif: "Event-loop stall",
    variant: "error",
    notifCooldownMs: STALL_NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = StallPayloadSchema.parse(row.data);
    return {
      title: `[stall] Event-loop stall: ${d.hotFrame} (${Math.round(d.durationMs)}ms)`,
      description: renderDescription(row, d),
    };
  },
});

// What the samples below can and cannot say, by what they cover.
function evidenceParagraph(d: StallPayload): string {
  if (d.scope === "block" && d.nSamples === 0) {
    return (
      `**No JS ran on the thread during the block.** The JSC sampling ` +
      `profiler took no sample inside it, so no stack of this process blocked ` +
      `the loop: the thread was off the CPU (descheduled on an overloaded host, ` +
      `or faulting its memory back in) or in native work outside the VM. Look ` +
      `at the host at this instant (Debug → Timeline: duress, load, memory ` +
      `compression), not at code.`
    );
  }
  if (d.scope === "block") {
    return (
      `**This report is the CAUSE.** The samples below are only the ones the ` +
      `background-thread JSC sampling profiler took during the block itself, so ` +
      `the stack named is what the thread ran while blocked. A block sampled ` +
      `far below the window's rate spent most of its time off the CPU or ` +
      `outside JS, and its few stacks are not shown to have caused it.`
    );
  }
  return (
    `**The block could not be placed: the samples below are the whole ` +
    `window's.** No event-loop stall the loop probe registered in this ` +
    `window is long enough to be this freeze, so its own samples could not be ` +
    `selected. The window mixes ordinary work around the block, so no stack ` +
    `below is shown to have blocked the thread` +
    (d.scope === undefined
      ? ` (this row was filed before freezes were scoped to their block).`
      : `.`)
  );
}

function renderDescription(row: ReportRow, d: StallPayload): string {
  const lines: string[] = [];

  // Coverage lead (Layer 4). When NO tracked span covered the freeze, this report
  // is the ONLY surface that names the culprit — say so up front, prominently.
  if (d.unspanned === true) {
    lines.push(
      `## ⚠️ PROFILER-INVISIBLE CULPRIT\n\n` +
        `**No tracked span covered this freeze.** The CPU burst inflated nothing ` +
        `the runtime profiler can see — \`get_runtime_profile\`, \`slow_ops\`, and ` +
        `\`byParent\` are all blind to it, so **this report is the only surface ` +
        `that names it**. This is the fire-and-forget / synchronous-CPU-block class ` +
        `(the \`prewarmBundle\` shape): detached work that runs with no ambient ` +
        `span. Fix: wrap the culprit named below in ` +
        `\`runTracked(label, fn)\` (\`@plugins/infra/plugins/runtime-profiler/core\`) ` +
        `so its cost becomes a first-class \`bg\` span.`,
    );
    lines.push("");
  } else if (d.unspanned === false && d.coveringSpan) {
    lines.push(
      `A tracked span **\`${d.coveringSpan.kind}:${d.coveringSpan.label}\`** was in ` +
        `flight across this freeze, so the CPU burst landed in that span's ` +
        `\`selfMs\` — it is visible (and traceable) in \`get_runtime_profile\` / ` +
        `\`slow_ops\` under that name.`,
    );
    lines.push("");
  }

  lines.push(
    `The main event loop was **frozen for ${Math.round(d.durationMs)}ms** ` +
      `(threshold ${Math.round(d.thresholdMs)}ms) — the whole backend blocked, ` +
      `serving nothing.`,
  );
  lines.push("");
  lines.push(evidenceParagraph(d));
  lines.push("");
  lines.push(
    `Any slow-op reports (page loads, delivers, flushNotifies) filed in the ` +
      `same window are **victims** of this freeze — they were merely waiting on ` +
      `the blocked loop, not slow in themselves.`,
  );
  lines.push("");
  lines.push(`**Freeze duration:** ${Math.round(d.durationMs)}ms`);
  lines.push(`**Threshold:** ${Math.round(d.thresholdMs)}ms`);
  lines.push(
    `**Samples:** ${d.nSamples} @ ~${d.sampleRateHz} Hz` +
      (d.spanMs !== undefined
        ? ` over ${Math.round(d.spanMs)}ms (${d.scope ?? "window"})`
        : "") +
      (d.windowSampleRateHz !== undefined
        ? ` — the thread was sampled at ~${d.windowSampleRateHz} Hz over the whole 10 s window`
        : ""),
  );
  lines.push(`**Dominant caller stack:** \`${d.culpritStack}\``);

  if (d.topLeaves.length > 0) {
    lines.push("");
    lines.push("**Top hot frames:**");
    for (const l of d.topLeaves) {
      lines.push(`- \`${l.key}\` — ${l.count} (${l.pct}%)`);
    }
  }

  if (d.topStacks.length > 0) {
    lines.push("");
    lines.push("**Top stacks:**");
    for (const s of d.topStacks) {
      lines.push(`- \`${s.stack}\` — ${s.count} (${s.pct}%)`);
    }
  }

  if (d.traceId) {
    lines.push("");
    lines.push(
      `**Trace:** the coherent-instant stall trace (the full JSC histogram + what ` +
        `else was in flight at the freeze) is at ` +
        `\`${traceDetailRoute.link(debugApp, { id: d.traceId })}\` (Debug → Slow Events).`,
    );
  }

  lines.push("");
  lines.push(`**Occurrences:** ${row.count}`);
  lines.push(`**Worktree:** ${row.worktree}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
