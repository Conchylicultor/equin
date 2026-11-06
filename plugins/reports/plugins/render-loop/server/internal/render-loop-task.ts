import type { ReportRow } from "@plugins/reports/server";
import { RenderLoopPayloadSchema } from "../../core";
import type { RenderLoopPayload } from "../../core";

const SAMPLE_MAX = 12;

// Notification re-arm window: a still-present render loop is a perf warning, not
// a one-shot crash, so it resurfaces occasionally (every 6h) rather than once-
// forever. Lives here (not the barrel) per barrel-purity.
export const RENDER_LOOP_NOTIF_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function payloadOf(row: ReportRow): RenderLoopPayload {
  // The row's data was validated by RenderLoopPayloadSchema at ingest, so this
  // is a total parse; failure would be a corrupted row (surfaced loudly).
  return RenderLoopPayloadSchema.parse(row.data);
}

const CLASS_LABEL: Record<RenderLoopPayload["mutationClass"], string> = {
  "noop-attr": "no-op attribute writes (value rewritten to itself)",
  "oscillating-attr": "oscillating attribute writes (a few values cycled)",
  "childlist-rebuild": "identical childList rebuild (same subtree torn down & rebuilt)",
  "subtree-cascade": "diffuse subtree cascade (a whole subtree re-rendered across many nodes)",
};

export function renderRenderLoopTask(row: ReportRow): {
  title: string;
  description: string;
} {
  return { title: renderTitle(row), description: renderDescription(row) };
}

function renderTitle(row: ReportRow): string {
  const data = payloadOf(row);
  const noisePrefix = row.noise ? "[noise] " : "";
  const rate = `${Math.round(data.ratePerSec)}/s`;
  const raw = `${noisePrefix}[render-loop] ${data.mutationClass} @ ${rate} — ${data.signature}`;
  return raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
}

function renderDescription(row: ReportRow): string {
  const data = payloadOf(row);
  const lines: string[] = [];

  lines.push(
    `A subtree was being **rebuilt / re-mutated continuously at a sustained high rate while the tab was idle and visible, with no meaningful content change** — wasted DOM work that burns CPU/battery. This is a performance bug, **not a crash**: there's no console error and no React "maximum update depth" warning, so nothing else surfaces it.`,
  );
  lines.push("");
  lines.push(`**How it was detected**`);
  lines.push(
    `A single global \`MutationObserver\` (event-driven, no polling) attributes every mutation to a stable culprit signature and keeps per-signature sliding-window rate counters. This loop fired all gates: it stayed above its class threshold for ≥3s (**sustained**), saw no pointer/keyboard/scroll input for ≈2s (**idle**), the tab was **visible**, and the work was **wasted** (no-op/oscillating attribute writes, or an identical add+remove childList rebuild whose tag+marker multisets match).`,
  );
  lines.push("");
  lines.push(`**Culprit**`);
  if (data.pluginId) {
    const slot = data.slotId ? `@${data.slotId}` : "";
    lines.push(`- **Plugin / slot:** \`${data.pluginId}${slot}\``);
  }
  if (data.contributionId) lines.push(`- **Contribution:** \`${data.contributionId}\``);
  if (data.source) lines.push(`- **Source:** \`${data.source}\``);
  if (data.owner) lines.push(`- **Owner:** \`${data.owner}\``);
  if (data.paneId) lines.push(`- **Pane:** \`${data.paneId}\``);
  if (data.selector) lines.push(`- **Selector:** \`${data.selector}\``);
  lines.push(`- **Signature:** \`${data.signature}\``);
  lines.push(`- **Mutation class:** ${CLASS_LABEL[data.mutationClass]}`);
  if (data.attrName) lines.push(`- **Attribute:** \`${data.attrName}\``);
  if (data.sampleValues && data.sampleValues.length > 0) {
    const sample = data.sampleValues
      .slice(0, SAMPLE_MAX)
      .map((v) => `\`${v}\``)
      .join(", ");
    lines.push(`- **Sample values:** ${sample}`);
  }
  if (data.tagMultiset && data.tagMultiset.length > 0) {
    lines.push(`- **Rebuilt nodes:** ${data.tagMultiset.join(", ")}`);
  }
  if (data.distinctLeaves != null) {
    lines.push(`- **Distinct nodes thrashing:** ${data.distinctLeaves}`);
  }
  if (data.sampleLeaves && data.sampleLeaves.length > 0) {
    const sample = data.sampleLeaves
      .slice(0, SAMPLE_MAX)
      .map((v) => `\`${v}\``)
      .join(", ");
    lines.push(`- **Sample nodes:** ${sample}`);
  }
  lines.push(`- **Rate:** ~${Math.round(data.ratePerSec)} mutations/sec`);
  lines.push(...attributionLines(data));
  lines.push(`- **Sustained:** ${Math.round(data.sustainedMs)}ms`);
  lines.push(`- **Visibility:** ${data.visibilityState}`);
  lines.push(`- **Idle for:** ${Math.round(data.msSinceInteraction)}ms before firing`);
  lines.push("");
  lines.push(`**Report**`);
  lines.push(`- **Source:** ${row.source}`);
  lines.push(`- **Worktree:** ${row.worktree}`);
  lines.push(`- **Fingerprint:** ${row.fingerprint}`);
  lines.push(`- **Count:** ${row.count}`);
  lines.push(`- **First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`- **Last seen:** ${row.lastSeenAt.toISOString()}`);
  if (row.url) lines.push(`- **URL:** ${row.url}`);
  if (row.userAgent) lines.push(`- **User-Agent:** ${row.userAgent}`);
  lines.push("");
  lines.push(`**How to fix**`);
  lines.push(fixAdvice(data));
  return lines.join("\n");
}

/**
 * What the React commit profiler saw while the loop ran (the detector watches
 * React's commits before it files). Absent on older rows and on compositions
 * without debug/render-profiler.
 */
function attributionLines(data: RenderLoopPayload): string[] {
  if (data.reactCommitsPerSec == null) {
    return [
      "- **React commits:** not measured (no commit profiler in this composition, or a profiling session was already running) — run `debug/render-profiler`'s `e2e/render-profile.ts` on the URL",
    ];
  }
  if (data.initiators == null || data.initiators.length === 0) {
    return [
      `- **React commits:** ~${data.reactCommitsPerSec}/sec, none from a component re-rendering at a loop's rate — the writes come from imperative code (a rAF loop, a third-party library), not a React re-render. If the subtree is an intended animation, declare its host with \`ANIMATION_HOST\` (render-loop core).`,
    ];
  }
  const lines = [`- **React commits:** ~${data.reactCommitsPerSec}/sec`];
  for (const i of data.initiators) {
    const hooks = i.hooks.length > 0 ? ` — changed ${i.hooks.join(", ")}` : "";
    const path =
      i.ancestors.length > 0 ? ` (in ${i.ancestors.join(" › ")})` : "";
    lines.push(
      `- **Re-rendered by:** \`${i.component}\`${path}${hooks}, ~${i.commitsPerSec}/sec`,
    );
  }
  return lines;
}

/** Per-mutation-class remediation guidance for the "How to fix" section. */
function fixAdvice(data: RenderLoopPayload): string {
  switch (data.mutationClass) {
    case "childlist-rebuild":
      return `The named subtree is being torn down and rebuilt every frame instead of reused. Find the component at the source/owner above and stabilize it: memoize the rendered children, give list items stable \`key\`s, or hoist a value/object/callback that's being recreated each render (it forces React to remount the whole subtree). Confirm the parent isn't re-rendering on a per-frame state/store update.`;
    case "subtree-cascade":
      return `A whole subtree under the named aggregate root (pane/plugin) is re-rendering across many nodes on a per-frame/idle cascade — no single node is hot, but together they thrash continuously while idle. This is almost always an unstable value/object/callback recreated on every render high in the subtree (so every descendant re-renders), or a per-frame state/store update at the root. Find the component owning the aggregate root above, memoize/stabilize the props and context value it passes down (\`useMemo\`/\`useCallback\`/stable refs), and confirm the root itself isn't re-rendering while idle (e.g. a subscription firing every frame). The **Sample nodes** above point at the hottest descendants.`;
    case "noop-attr":
    case "oscillating-attr":
      if (data.attrName === "name" || data.attrName === "type") {
        return `React 19 re-assigns an \`<input>\`'s \`${data.attrName}\` on every commit of the element (even unchanged), so these writes mean the component rendering this input re-renders continuously — no code of ours writes the attribute. Find what re-renders it (**Re-rendered by** above, or \`debug/render-profiler\`) and stop the update at its source.`;
      }
      return `An attribute is being rewritten to the same (or a small cycling set of) value(s) every frame with no visible effect. Find the effect/render at the source/owner above that writes this attribute and gate it on an actual value change (skip the write when the new value equals the current one), or move it out of the per-frame path. A monotonic progress bar/timer is exempt by design — this fired because the value **oscillates/repeats**, which is wasted work.`;
  }
}
