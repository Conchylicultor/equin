import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { GatewayPanicPayloadSchema } from "../../core";

// One-line summary for Debug → Reports, e.g. "`(*backend).incHTTP` GET
// /api/health · 240×".
export function GatewayPanicSummary({ report }: { report: Report }) {
  const parsed = GatewayPanicPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;
  return (
    <Inline gap="xs">
      <Badge variant="destructive" mono>
        {d.site.replace(/^equin\/gateway\./, "")}
      </Badge>
      <span>
        {d.method} {d.path}
      </span>
      {d.count > 1 && <span className="text-muted-foreground">{d.count}×</span>}
    </Inline>
  );
}
