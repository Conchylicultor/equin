import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { BackendCrashPayloadSchema, bunPanicOf, uptimeOf } from "../../core";

// One-line summary for Debug → Reports, e.g. "`main` SIGSEGV after 1h 04m
// panic: Segmentation fault at address 0x28".
export function BackendCrashSummary({ report }: { report: Report }) {
  const parsed = BackendCrashPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;
  const { panic } = bunPanicOf(d);
  return (
    <Inline gap="xs">
      <Badge variant="destructive" mono>
        {d.worktree}
      </Badge>
      <span>
        {d.signal} after {uptimeOf(d)}
      </span>
      {panic !== null && <span className="text-muted-foreground">{panic}</span>}
    </Inline>
  );
}
