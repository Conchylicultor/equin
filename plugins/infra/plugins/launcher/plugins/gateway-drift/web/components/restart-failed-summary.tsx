import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { GatewayRestartFailedPayloadSchema } from "../../core";

// One-line summary for Debug → Reports, e.g. "`rolled back` binary built from older …".
export function GatewayRestartFailedSummary({ report }: { report: Report }) {
  const parsed = GatewayRestartFailedPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;
  const how =
    d.stage === "refused"
      ? "not tried"
      : d.rollback.kind === "restored"
        ? "rolled back"
        : d.rollback.kind === "failed"
          ? "rollback failed"
          : "failed";
  return (
    <Inline gap="xs">
      <Badge variant="destructive" mono>
        {how}
      </Badge>
      <span>{d.differences.join("; ")}</span>
    </Inline>
  );
}
