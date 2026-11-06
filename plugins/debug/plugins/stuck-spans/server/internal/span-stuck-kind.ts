import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { traceDetailRoute } from "@plugins/debug/plugins/trace/plugins/engine/core";
import {
  SPAN_STUCK_KIND,
  StuckSpanPayloadSchema,
  type StuckSpanPayload,
} from "../../core";
import { describeChain, formatAge } from "../../shared/message";

// Re-alert the bell at most once per 10 minutes for the same operation. Each
// stuck RUN files once, so a new bell for the same operation means a new run got
// stuck — worth surfacing again, but not once per run in a burst. Same cadence
// as the queue-health and job-deadline kinds.
const NOTIF_COOLDOWN_MS = 600_000;

// The incident this kind exists for. Named in every task so whoever picks one up
// starts from what is already known about how an operation gets stuck forever.
const INCIDENT_DOC =
  "research/2026-09-11-global-live-updates-frozen-by-stray-fd-close.md";

/**
 * The `span-stuck` report kind: **an operation is still running, long past the
 * point where anything on its path should take.**
 *
 * It fires WHILE the operation is stuck, which is the whole point: a slow-op
 * report is filed when a span completes, so a span that never completes files
 * nothing. That is how the 2026-09-11 flush stayed open for 25+ minutes with no
 * alert.
 *
 * Deduped per operation (`kind` + `label`): repeated stalls of the same
 * operation collapse onto one row whose count says how many runs got stuck.
 * The per-run bound (one report per span id) lives in the watchdog, not here.
 *
 * Variant `error`: an operation that never returns usually holds something
 * others wait on — a stuck flush freezes every live update in the worktree.
 */
export const spanStuckKind = ReportKind({
  kind: SPAN_STUCK_KIND,
  schema: StuckSpanPayloadSchema,
  fingerprint: (d: StuckSpanPayload) =>
    `${SPAN_STUCK_KIND}:${d.kind}:${d.label}`,
  // A hang and a host duress episode are often the same event — and duress is
  // exactly when the reports funnel sheds, so without this flag the alarm for
  // the hang could be buffered or dropped by the hang. Exempting it is safe on
  // volume: the watchdog files each span run once, so the count of these
  // reports is bounded by the number of runs that actually got stuck. Same
  // argument as queue-wedged and job-zombie.
  duressExempt: true,
  meta: {
    tag: "[stuck]",
    notif: "An operation is stuck",
    variant: "error",
    notifCooldownMs: NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = StuckSpanPayloadSchema.parse(row.data);
    return {
      title: `[stuck] ${d.kind} ${d.label} did not finish after ${formatAge(d.ageMs)}`,
      description: renderDescription(row, d),
    };
  },
});

function renderDescription(row: ReportRow, d: StuckSpanPayload): string {
  const lines: string[] = [];
  lines.push(
    `\`${d.kind} ${d.label}\` had been running for **${formatAge(d.ageMs)}** ` +
      `and had not finished when the stuck-span watchdog looked. Its threshold ` +
      `is ${formatAge(d.thresholdMs)}. This is filed once per run, so that age ` +
      `is a lower bound — the run may still be going.`,
  );
  if (d.runs !== undefined && d.runs > 1) {
    lines.push("");
    lines.push(
      `**${d.runs} runs** of this operation were found stuck at the same instant ` +
        `(the age and chain above are the oldest's). Many runs of one operation ` +
        `stuck together usually share one cause — a gate or lock they all queue ` +
        `on: look at the trace's gate lane for what holds it.`,
    );
  }
  lines.push("");
  lines.push(`**Where it was running:** \`${describeChain(d)}\``);
  if (d.ancestors.length > 0) {
    lines.push("");
    lines.push(
      "Everything to the left of the last step is still waiting on it. The " +
        "watchdog reports only the deepest stuck operation of a chain, so the " +
        "outer ones do not get their own report while this one is stuck.",
    );
  }
  if (d.kind === "flush" || d.ancestors.some((a) => a.kind === "flush")) {
    lines.push("");
    lines.push(
      "**Live updates in this worktree are frozen.** Live-state flushes run one " +
        "at a time, so every database change since this flush started is " +
        "queued behind it. Open tabs will not update — including this " +
        "report's own bell, which rides the same live-state channel. " +
        "Refreshing a tab does not help; restarting the backend does.",
    );
  }
  lines.push("");
  lines.push(
    "**This report detects; it does not recover.** Nothing cancels the " +
      "operation. A lost database query is failed by the query deadline " +
      "(and reported as `db-query-deadline`) before this threshold, so this " +
      "operation is most likely stuck on something the deadline does not " +
      "cover — a child process, a lock, a network call, a promise a bug " +
      "never settles. That stays stuck until the backend restarts.",
  );
  lines.push("");
  lines.push(
    "**What to do:** open the trace and find the stuck span in the spans lane. " +
      "What it last waited on (its wait bands, and the gates lane) and what " +
      "finished just before it usually names the cause. Then add a bound to " +
      "whatever it awaits, so the next time it fails loudly instead of " +
      `hanging. Background on how operations get stuck forever: \`${INCIDENT_DOC}\`.`,
  );
  if (d.traceId !== null) {
    lines.push("");
    lines.push(
      `**Trace:** everything in flight when this was detected is at ` +
        `\`${traceDetailRoute.link(debugApp, { id: d.traceId })}\` (Debug → Slow Events).`,
    );
  }
  lines.push("");
  lines.push(`**Span id:** ${d.spanId}`);
  lines.push(`**Occurrences (separate stuck runs):** ${row.count}`);
  lines.push(`**Worktree:** ${row.worktree}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
