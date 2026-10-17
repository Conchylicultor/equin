import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { DbAbandonCapPayloadSchema } from "../../core";

// One-line summary for the Debug → Reports list, e.g.
// "33 abandoned database connections — over the cap of 32 · latest [jobs-runner]".
// The cap is process-wide, so the pool is only the latest abandon's, not a
// breakdown — the db-query-deadline rows carry that.
export function AbandonCapSummary({ report }: { report: Report }) {
  const parsed = DbAbandonCapPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;

  return (
    <Inline gap="xs">
      <span>
        {d.abandoned} abandoned database connections — over the cap of {d.cap}
      </span>
      <span className="text-muted-foreground">· latest</span>
      <Badge mono tooltip={`Connection pool: ${d.pool}`}>
        {d.pool}
      </Badge>
    </Inline>
  );
}
