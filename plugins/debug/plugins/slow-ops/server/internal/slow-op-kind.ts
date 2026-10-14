import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { traceDetailRoute } from "@plugins/debug/plugins/trace/plugins/engine/core";
import {
  SlowOpReportPayloadSchema,
  type SlowOpReportPayload,
} from "../../core";
import { TRANSPORT_LAYER } from "../../shared/endpoints";
import { describeWaits } from "./wait-layers";

// The slow-op report kind. Dedups per distinct `${operationKind}:${operation}`,
// so each slow operation gets its own report pointing straight at the offending op
// — keeping its own count, caller history, and context — while distinct slow ops
// get distinct reports (a slow loader for resource X is a different bug than a slow
// HTTP route Y). The live ranked breakdown across all ops still lives in the
// slow_ops store / Debug → Slow Ops; each report drills into one of them.
export const slowOpKind = ReportKind({
  kind: "slow-op",
  schema: SlowOpReportPayloadSchema,
  fingerprint: (d: SlowOpReportPayload) =>
    `slow-op:${d.operationKind}:${d.operation}`,
  meta: {
    tag: "[slow-op]",
    notif: "Slow operation detected",
    variant: "warning",
    // No notifCooldownMs, unlike most sibling kinds: a slow op is a recurring
    // metric, so it wants the SHORTEST re-alert the engine allows — which is
    // the engine's own floor. It used to name 60 s here; the floor is 10
    // minutes, so that number bought nothing and only read as if it did. This
    // is the noisiest kind in the table, and quieter is the right direction
    // for it anyway.
  },
  renderTask: (row: ReportRow) => {
    const d = SlowOpReportPayloadSchema.parse(row.data);
    const coldStartSuffix = d.transportColdStart
      ? " — transport cold-start"
      : "";
    return {
      title: `[slow-op] ${d.operationKind} ${d.operation} — ${Math.round(d.durationMs)}ms${coldStartSuffix}`,
      description: renderDescription(row, d),
    };
  },
});

function renderDescription(row: ReportRow, d: SlowOpReportPayload): string {
  const lines: string[] = [];
  lines.push(
    `The \`${d.operationKind}\` operation \`${d.operation}\` has been exceeding ` +
      `its configured slow-op threshold of ${d.thresholdMs}ms.`,
  );
  lines.push("");
  lines.push(`**Operation:** \`${d.operationKind}\` \`${d.operation}\``);
  lines.push(`**Latest duration:** ${Math.round(d.durationMs)}ms`);
  lines.push(`**Threshold:** ${d.thresholdMs}ms`);
  if (d.transportColdStart) {
    const socketMs = d.waits?.[TRANSPORT_LAYER] ?? d.transportWaitMs;
    const waited =
      socketMs !== undefined
        ? ` (waited ~${Math.round(socketMs)}ms for the socket)`
        : "";
    lines.push("");
    lines.push(
      `**Root cause:** the notifications transport was not ready when this ` +
        `resource mounted${waited}. This duration is time-to-first-data over the ` +
        `transport, not the resource's own compute cost — investigate ` +
        `transport/boot readiness, not this resource. (Cold-start slowness is ` +
        `still a real regression to fix at the source.)`,
    );
  }
  const waitLines = describeWaits(d);
  if (waitLines.length > 0) lines.push("", ...waitLines);
  if (d.traceId) {
    lines.push("");
    lines.push(
      `**Trace:** the coherent-instant flight window (spans / gates / contention) ` +
        `captured for this trip is at \`${traceDetailRoute.link(debugApp, { id: d.traceId })}\` ` +
        `(Debug → Slow Events).`,
    );
  }
  lines.push("");
  lines.push(
    "See this op's full ranked breakdown — total time, max, and caller " +
      "attribution — in **Debug → Slow Events → Aggregates**.",
  );
  lines.push("");
  lines.push(`**Occurrences:** ${row.count}`);
  lines.push(`**Worktree:** ${row.worktree}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
