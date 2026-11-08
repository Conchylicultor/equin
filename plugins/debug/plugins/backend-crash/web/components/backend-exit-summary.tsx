import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { BackendExitPayloadSchema, exitPhaseOf } from "../../core";

// One-line summary for Debug → Reports, e.g. "`main` code 1 5.0s after ready
// (8.0s up)".
export function BackendExitSummary({ report }: { report: Report }) {
  const parsed = BackendExitPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;
  return (
    <Inline gap="xs">
      <Badge variant="destructive" mono>
        {d.worktree}
      </Badge>
      <span>
        code {d.exitCode} {exitPhaseOf(d)}
      </span>
    </Inline>
  );
}
