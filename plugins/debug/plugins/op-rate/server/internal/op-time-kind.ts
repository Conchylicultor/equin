import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { traceDetailRoute } from "@plugins/debug/plugins/trace/plugins/engine/core";
import { OpTimePayloadSchema, type OpTimePayload } from "../../core";

// Re-alert the bell at most once per 10 minutes while an op stays over its
// aggregate-time budget. Like op-rate, a count×cost breach is a persistent
// condition (the op keeps burning time tick after tick), not a one-shot
// incident, so the cooldown re-surfaces it periodically without spamming.
const OP_TIME_NOTIF_COOLDOWN_MS = 600_000;

// The `op-time` report kind — the aggregate-time (count×cost) twin of `op-rate`.
// Two shapes share the schema, discriminated by `label`: per-op (one op burned
// too many ms/window past its per-kind budget) fingerprints
// `op-time:<kind>:<label>`; per-kind rollup (cost smeared across many labels)
// fingerprints `op-time:rollup:<kind>`. Variant `warning`: an aggregate-time
// breach is a degradation signal (it points at where wall-clock is being spent),
// not a hard failure.
export const opTimeKind = ReportKind({
  kind: "op-time",
  schema: OpTimePayloadSchema,
  fingerprint: (d: OpTimePayload) =>
    d.label ? `op-time:${d.kind}:${d.label}` : `op-time:rollup:${d.kind}`,
  meta: {
    tag: "[op-time]",
    notif: "Endpoint aggregate-time budget breach",
    variant: "warning",
    notifCooldownMs: OP_TIME_NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = OpTimePayloadSchema.parse(row.data);
    const secs = (d.msInWindow / 1000).toFixed(1);
    const what =
      d.kind === "wait" && d.label
        ? `wait ${d.label}`
        : d.label
          ? `${d.kind} ${d.label}`
          : `${d.kind} rollup`;
    return {
      title: `[op-time] ${what} — ${secs}s/window`,
      description: renderDescription(row, d),
    };
  },
});

function renderDescription(row: ReportRow, d: OpTimePayload): string {
  const lines: string[] = [];
  const secs = (d.msInWindow / 1000).toFixed(1);
  const budgetSecs = (d.budgetMs / 1000).toFixed(1);
  const avgMs = d.callsInWindow > 0 ? Math.round(d.msInWindow / d.callsInWindow) : 0;

  if (d.kind === "wait" && d.label) {
    lines.push(
      `Operations waited **${secs}s** in total on the \`${d.label}\` gate ` +
        `within a single monitor window (${d.callsInWindow} waits) — past the ` +
        `gate budget of ${budgetSecs}s. Every op is judged on its own time, so ` +
        `the time it queued is reported here, once, against the gate. Look at ` +
        `what HOLDS the gate (below, and the trace's gate lane): why does it ` +
        `hold a slot that long, or why are there so many waiters?`,
    );
    lines.push("");
    lines.push(`**Gate:** \`${d.label}\``);
    if (d.holders && d.holders.length > 0) {
      lines.push(`**Holders when it tripped:**`);
      for (const h of d.holders) lines.push(`- \`${h}\``);
    }
  } else if (d.label) {
    const wall =
      d.wallMsInWindow !== undefined
        ? ` (${(d.wallMsInWindow / 1000).toFixed(1)}s wall — the rest was waits, ` +
          `holds and children, each judged where it belongs)`
        : "";
    lines.push(
      `The \`${d.kind}\` op \`${d.label}\` did **${secs}s** of its own work${wall} ` +
        `within a single monitor window — past its per-kind aggregate-time budget ` +
        `of ${budgetSecs}s. That is **${d.callsInWindow} calls × ~${avgMs}ms avg**: ` +
        `neither per-call latency (slow-op) nor call count (op-rate) alone would ` +
        `flag it. Investigate whether the op is being over-called, is individually ` +
        `slow, or both.`,
    );
    lines.push("");
    lines.push(`**Op:** \`${d.kind}\` \`${d.label}\``);
    lines.push(`**Time in window:** ${secs}s across ${d.callsInWindow} calls (~${avgMs}ms avg)`);
    lines.push(`**Budget:** ${budgetSecs}s`);
  } else {
    lines.push(
      `The \`${d.kind}\` kind did **${secs}s** of its own work across all its ` +
        `labels within a single monitor window — past the per-kind rollup budget of ` +
        `${budgetSecs}s (per-op budget × rollup factor). This catches cost smeared ` +
        `across many labels, each under its own per-op budget. The top contributors ` +
        `are listed below.`,
    );
    lines.push("");
    lines.push(`**Kind:** \`${d.kind}\` (rollup across all labels)`);
    lines.push(`**Time in window:** ${secs}s across ${d.callsInWindow} calls`);
    lines.push(`**Rollup budget:** ${budgetSecs}s`);
    if (d.topLabels && d.topLabels.length > 0) {
      lines.push("");
      lines.push("**Top contributors:**");
      for (const t of d.topLabels) {
        lines.push(`- \`${t.label}\` — ${(t.deltaMs / 1000).toFixed(1)}s`);
      }
    }
  }

  lines.push(`**Window:** ${Math.round(d.windowMs / 1000)}s`);
  if (d.traceId) {
    lines.push("");
    lines.push(
      `**Trace:** the coherent-instant flight window (what was in flight while this ` +
        `op burned time) captured at the trip is at ` +
        `\`${traceDetailRoute.link(debugApp, { id: d.traceId })}\` (Debug → Slow Events).`,
    );
  }
  lines.push("");
  lines.push(
    "Inspect the live per-op time aggregates in the **Debug → Slow Events** / " +
      "runtime profiler surfaces (the per-op `selfTotalMs` and per-gate `gates` this monitor diffs).",
  );
  lines.push("");
  lines.push(`**Occurrences:** ${row.count}`);
  lines.push(`**Worktree:** ${row.worktree}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
