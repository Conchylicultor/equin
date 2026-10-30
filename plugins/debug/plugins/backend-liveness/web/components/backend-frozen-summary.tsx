import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { BackendFrozenPayloadSchema, humanMs } from "../../core";

// One-line summary for Debug → Reports, e.g. "`agent-42` no answer for 4m
// (frozen)".
export function BackendFrozenSummary({ report }: { report: Report }) {
  const parsed = BackendFrozenPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;
  return (
    <Inline gap="xs">
      <Badge variant="destructive" mono>
        {d.worktree}
      </Badge>
      <span>no answer for {humanMs(d.unansweredMs)}</span>
      <span className="text-muted-foreground">({d.state})</span>
    </Inline>
  );
}
