import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { ServiceDownPayloadSchema, outageOf, upTimeOf } from "../../core";

// One-line summary for Debug → Reports, e.g. "`postgres` down after 3h 02m
// up · back after 4.2s".
export function ServiceDownSummary({ report }: { report: Report }) {
  const parsed = ServiceDownPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;
  const up = upTimeOf(d);
  return (
    <Inline gap="xs">
      <Badge variant="destructive" mono>
        {d.service}
      </Badge>
      <span>
        {up === null ? "stopped answering" : `stopped answering after ${up} up`}
      </span>
      <span className="text-muted-foreground">
        {d.outcome === "recovered"
          ? `back after ${outageOf(d)}`
          : "re-start failed, left down"}
      </span>
    </Inline>
  );
}
