import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { TraceChip } from "@plugins/debug/plugins/trace/plugins/engine/web";
import { StuckSpanPayloadSchema } from "../../core";
import {
  describeChain,
  describeHolders,
  describeWaiters,
  stuckSpanSummaryLead,
} from "../../shared/message";

// One-line span-stuck summary for the Debug → Reports list, e.g.
// "[stuck] still running after 3 min: flush flushNotifies → push
// conversations-gone:count" — or, for a gate not admitting its waiters, "121
// waiting on read-admit for 1 min, held by: host-fs.peek … (1 min)", or for a file call that has not returned "1 waiting on
// fs-readdir for 2 min: sub host-fs.peek" — plus a View-trace chip onto everything that was in
// flight when it was detected. The destructive chip is what separates it at a
// glance from a slow-op row: that one finished slowly, this one had not
// finished at all.
export function SpanStuckSummary({ report }: { report: Report }) {
  const parsed = StuckSpanPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;
  const traceId = d.traceId;

  return (
    <Inline gap="xs">
      <Badge variant="destructive">stuck</Badge>
      <span>{stuckSpanSummaryLead(d)}</span>
      <Badge mono>
        {!d.gate
          ? describeChain(d)
          : d.gate.waitKind === "io"
            ? describeWaiters(d.gate)
            : describeHolders(d.gate)}
      </Badge>
      {traceId !== null && <TraceChip traceId={traceId} />}
    </Inline>
  );
}
