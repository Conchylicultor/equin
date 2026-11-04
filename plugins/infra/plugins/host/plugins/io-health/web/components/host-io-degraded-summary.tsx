import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { HostIoDegradedPayloadSchema } from "../../core";

// One-line summary for the Debug → Reports list, e.g.
//   [daemon-cpu] [fseventsd] fseventsd has used 82 % CPU (median) for the last hour
export function HostIoDegradedSummary({ report }: { report: Report }) {
  const parsed = HostIoDegradedPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const f = parsed.data;
  return (
    <Inline gap="xs">
      <Badge variant={f.severity === "critical" ? "destructive" : "warning"}>
        {f.rule}
      </Badge>
      <Badge mono>{f.subject}</Badge>
      <span>{f.summary}</span>
    </Inline>
  );
}
