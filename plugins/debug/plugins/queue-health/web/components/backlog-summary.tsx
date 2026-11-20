import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { QueueBacklogPayloadSchema } from "../../core";
import { formatDurationMs } from "../../shared/format-duration";

// One-line backlog summary for the Debug → Reports list, e.g.
// "289 ready · oldest 1h 10m · 0 running" with a red "stalled" chip when the
// worker is making no progress, plus the top ready-queue offenders (mono chips)
// attributing the backlog when the payload carries them.
export function BacklogSummary({ report }: { report: Report }) {
  const parsed = QueueBacklogPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;

  return (
    <Inline gap="xs">
      <span>
        {d.readyCount} ready · oldest{" "}
        {formatDurationMs(d.oldestAwakeOverdueMs ?? d.oldestOverdueMs)} ·{" "}
        {d.lockedCount} running
      </span>
      {d.stalled ? <Badge variant="destructive">stalled</Badge> : null}
      {d.topReady?.map((j) => (
        <Badge key={j.jobName} mono>
          {j.jobName} ×{j.readyCount}
        </Badge>
      ))}
    </Inline>
  );
}
