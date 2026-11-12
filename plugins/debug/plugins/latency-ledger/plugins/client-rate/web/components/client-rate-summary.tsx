import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { ClientRatePayloadSchema } from "../../core";

// One-line summary for Debug → Reports, e.g.
// "`page-load /demo/at/sonata` ×34 this hour — usually ≤10 per client-hour · automated".
export function ClientRateSummary({ report }: { report: Report }) {
  const parsed = ClientRatePayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;
  return (
    <Inline gap="xs">
      <Badge variant="warning" mono>
        {d.interaction} {d.route}
      </Badge>
      <span>
        ×{d.count} this hour from one tab — usually ≤{d.usual} per client-hour
      </span>
      {d.automated && <Badge variant="info">automated</Badge>}
    </Inline>
  );
}
