import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { TraceChip } from "@plugins/debug/plugins/trace/plugins/engine/web";
import { StallPayloadSchema } from "../../core";

// One-line event-loop-stall summary for the Debug → Reports list, e.g.
// "`parseTranscript @ …` — 4200ms", plus a View-trace chip deep-linking the
// coherent-instant stall evidence when captureTrace admitted one.
export function StallSummary({ report }: { report: Report }) {
  const parsed = StallPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;

  return (
    <Inline gap="xs">
      <Badge variant="destructive" mono>
        {d.hotFrame}
      </Badge>
      <span>— {Math.round(d.durationMs)}ms</span>
      {d.traceId && <TraceChip traceId={d.traceId} />}
    </Inline>
  );
}
