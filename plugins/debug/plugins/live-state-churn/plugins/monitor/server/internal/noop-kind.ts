import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import {
  LiveStateNoopPayloadSchema,
  type LiveStateNoopPayload,
} from "../../core";

// Re-alert the bell at most once per ~6h while a resource keeps churning. A no-op
// push storm is a persistent condition (the writer/trigger keeps recomputing
// every tick), not a one-shot incident, so the cooldown re-surfaces it
// periodically without spamming — same rationale as queue-backlog's cooldown,
// matching the render-loop detector's 6h re-arm.
const NOOP_NOTIF_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// The `live-state-noop` report kind. Dedups per distinct resource key
// (fingerprint `live-state-noop:<resourceKey>`), so a sustained churn on one
// resource collapses to a single task while distinct churning resources get
// distinct tasks. Variant `warning`: the pushes carry no content change — they
// waste CPU + WS frames + client wakeups but don't break anything.
export const noopKind = ReportKind({
  kind: "live-state-noop",
  schema: LiveStateNoopPayloadSchema,
  fingerprint: (d: LiveStateNoopPayload) => `live-state-noop:${d.resourceKey}`,
  meta: {
    tag: "[live-state]",
    notif: "Redundant live-state pushes",
    variant: "warning",
    category: "error",
    notifCooldownMs: NOOP_NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = LiveStateNoopPayloadSchema.parse(row.data);
    return {
      title: `[live-state] Redundant pushes: ${d.resourceKey}`,
      description: renderDescription(row, d),
    };
  },
});

function renderDescription(row: ReportRow, d: LiveStateNoopPayload): string {
  const lines: string[] = [];
  lines.push(
    `The live-state resource \`${d.resourceKey}\` is being recomputed and pushed ` +
      `to ${d.subscribers} subscriber${d.subscribers === 1 ? "" : "s"} at a sustained ` +
      `rate while producing **no content change** — the keyed diff is empty (no ` +
      `upserts, no deletes, order unchanged).`,
  );
  lines.push("");
  lines.push(
    `Each such push carries zero information yet still costs a server recompute, ` +
      `one WebSocket frame per subscriber, and a client wakeup. This is wasted ` +
      `server CPU and network for no benefit.`,
  );
  lines.push("");
  lines.push(`**Resource key:** \`${d.resourceKey}\``);
  lines.push(`**No-op rate:** ~${d.noopRate.toFixed(1)} no-op pushes/sec`);
  lines.push(
    `**No-op / total:** ${d.noopCount} / ${d.totalCount} pushes over ${d.windowSeconds}s`,
  );
  lines.push(`**Subscribers:** ${d.subscribers}`);
  lines.push("");
  lines.push(
    `**Fix:** find and eliminate the writer/trigger that recomputes this resource ` +
      `without a real change. The recompute fires on every tick even though the ` +
      `value is unchanged — track down what is calling \`notify()\` (or what DB ` +
      `change feeds the resource) and gate it on an actual content change.`,
  );
  lines.push("");
  lines.push(`**Occurrences:** ${row.count}`);
  lines.push(`**Worktree:** ${row.worktree}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
