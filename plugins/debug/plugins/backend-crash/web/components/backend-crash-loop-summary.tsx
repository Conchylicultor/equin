import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { formatDuration } from "@plugins/fields/plugins/duration/core";
import { BackendCrashLoopPayloadSchema, loopCausesOf } from "../../core";

// One-line summary for Debug → Reports, e.g. "`main` 83 deaths in 27m 48s
// exit 1 ×20 (ended, now running)".
export function BackendCrashLoopSummary({ report }: { report: Report }) {
  const parsed = BackendCrashLoopPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;
  return (
    <Inline gap="xs">
      <Badge variant="destructive" mono>
        {d.worktree}
      </Badge>
      <span>
        {d.deaths} deaths in {formatDuration(d.lastDeathAt - d.firstDeathAt)}
      </span>
      <span className="text-muted-foreground">
        {loopCausesOf(d)}
        {d.state === "ended"
          ? ` (ended, now ${d.stateAtEnd ?? "?"})`
          : " (looping)"}
      </span>
    </Inline>
  );
}
