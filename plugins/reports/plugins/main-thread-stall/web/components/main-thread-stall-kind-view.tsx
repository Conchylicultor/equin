import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { MainThreadStallPayloadSchema } from "../../core";

// One-line Debug → Reports summary: how the stall ended, how long, where (app +
// route pattern), what ran (or `unattributed`), and how many tabs froze with it.
export function MainThreadStallKindView({ report }: { report: Report }) {
  const parsed = MainThreadStallPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;
  const secs = (d.durationMs / 1000).toFixed(1);

  return (
    <Inline gap="xs">
      <Badge variant={d.ended === "recovered" ? "warning" : "destructive"} mono>
        {d.ended}
      </Badge>
      <span className="tabular-nums">
        {d.durationIsLowerBound ? "≥" : ""}
        {secs}s
      </span>
      <span className="truncate font-mono" title={d.url}>
        {d.app ?? "?"} {d.routePattern}
      </span>
      <span className="truncate text-muted-foreground font-mono">
        {d.topFunction ?? "unattributed"}
      </span>
      {d.cohort.length > 0 && (
        <span className="text-muted-foreground">+{d.cohort.length} tabs</span>
      )}
    </Inline>
  );
}
