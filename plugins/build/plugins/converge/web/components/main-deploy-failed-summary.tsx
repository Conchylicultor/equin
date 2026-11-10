import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { MainDeployFailedPayloadSchema } from "../../core";

// One-line summary for Debug → Reports, e.g. "`exit 1` ref advanced".
export function MainDeployFailedSummary({ report }: { report: Report }) {
  const parsed = MainDeployFailedPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;
  const how =
    d.spawnError !== null
      ? "not started"
      : d.signal !== null
        ? d.signal
        : `exit ${d.exitCode}`;
  return (
    <Inline gap="xs">
      <Badge variant="destructive" mono>
        {how}
      </Badge>
      <span>{d.causes.join(", ")}</span>
    </Inline>
  );
}
