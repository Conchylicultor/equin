import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { TraceChip } from "@plugins/debug/plugins/trace/plugins/engine/web";
import {
  isLegacyBurstReport,
  SlowOpReportPayloadSchema,
} from "@plugins/debug/plugins/slow-ops/core";

// One-line Debug → Reports summary for the slow-op kind (previously fell back to
// the raw message): `kind label — Nms (threshold Mms)`, plus a View-trace chip
// deep-linking the durable coherent-instant evidence when the trip captured one.
export function SlowOpKindView({ report }: { report: Report }) {
  const parsed = SlowOpReportPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;

  return (
    <Inline gap="xs">
      <Badge variant="warning" mono>
        {d.operationKind}:{d.operation}
      </Badge>
      {d.burst &&
        (isLegacyBurstReport(d) ? (
          <span>
            {d.burst.count} ops at once, slowest{" "}
            {d.burst.operations[0]?.operation}
          </span>
        ) : (
          <span className="text-muted-foreground">
            1 of {d.burst.count} at once
          </span>
        ))}
      <span>— {Math.round(d.ownMs ?? d.durationMs)}ms</span>
      <span className="text-muted-foreground">
        (threshold {Math.round(d.thresholdMs)}ms)
      </span>
      {d.traceId && <TraceChip traceId={d.traceId} />}
    </Inline>
  );
}
