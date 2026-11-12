import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import { OpRatePayloadSchema, type OpRatePayload } from "../../core";

// Re-alert the bell at most once per 10 minutes while an op stays hot. A
// call-rate spike is a persistent condition (the op keeps getting hammered tick
// after tick), not a one-shot incident, so the cooldown re-surfaces it
// periodically without spamming — same rationale as slow-op's cooldown.
const OP_RATE_NOTIF_COOLDOWN_MS = 600_000;

// The `op-rate` report kind. Dedups per distinct `${kind}:${label}`, so each hot
// op gets its own report pointing directly at the cause (the over-called op),
// while distinct hot ops get distinct reports. Variant `warning`: a call-rate
// spike is a degradation signal (it points at the cause of load), not a hard
// failure.
export const opRateKind = ReportKind({
  kind: "op-rate",
  schema: OpRatePayloadSchema,
  fingerprint: (d: OpRatePayload) => `op-rate:${d.kind}:${d.label}`,
  meta: {
    tag: "[op-rate]",
    notif: "Endpoint call-rate spike",
    variant: "warning",
    notifCooldownMs: OP_RATE_NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = OpRatePayloadSchema.parse(row.data);
    return {
      title: `[op-rate] ${d.kind} ${d.label} — ${d.callsInWindow} calls/${d.baseline?.over === "hour" ? "hour" : "window"}`,
      description: renderDescription(row, d),
    };
  },
});

// What the calls were counted over, in words, and the quantile its usual count
// is (op-rate-baseline.ts).
const SPAN_WORDS = {
  boot: { span: "a boot window (a backend's first minutes)", quantile: "90th" },
  steady: { span: "a steady monitor window", quantile: "99th" },
  hour: { span: "the clock hour so far", quantile: "95th" },
} as const;

function renderDescription(row: ReportRow, d: OpRatePayload): string {
  const lines: string[] = [];
  const base = d.baseline;
  const per = base?.over === "hour" ? "hour" : "window";
  if (base) {
    const words = SPAN_WORDS[base.over];
    lines.push(
      `The \`${d.kind}\` op \`${d.label}\` was called **${d.callsInWindow}** ` +
        `times in ${words.span}, where it is usually called at most ` +
        `${base.usualCalls} times (the ${words.quantile} percentile of its last 7 ` +
        `days) — past the threshold of ${d.threshold}. Something is calling it ` +
        "far more than it normally does; investigate who is issuing these calls.",
    );
  } else
    lines.push(
      `The \`${d.kind}\` op \`${d.label}\` was called **${d.callsInWindow}** ` +
        `times within a single monitor window — past the per-kind warm-up ` +
        `threshold of ${d.threshold} (this backend had under a day of call ` +
        "history to judge the op against its own usual rate). Investigate who " +
        "is issuing this many calls.",
    );
  lines.push("");
  lines.push(`**Op:** \`${d.kind}\` \`${d.label}\``);
  lines.push(`**Calls in ${per}:** ${d.callsInWindow}`);
  lines.push(
    `**Counted over:** ${base ? `${base.over} ` : ""}(${Math.round(d.windowMs / 1000)}s)`,
  );
  if (base) lines.push(`**Usual calls in such a ${per}:** ${base.usualCalls}`);
  lines.push(`**Threshold:** ${d.threshold}`);
  lines.push("");
  lines.push(
    "Inspect the live call counts in the **Debug → Reports** / runtime " +
      "profiler surfaces (the per-op `count` aggregates this monitor diffs).",
  );
  lines.push("");
  lines.push(`**Occurrences:** ${row.count}`);
  lines.push(`**Worktree:** ${row.worktree}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
