import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { PanelOverflowPayloadSchema } from "@plugins/reports/plugins/panel-overflow/core";

// One-line Debug → Reports summary for the panel-overflow kind: which panel
// and page, and by how much its content overflows.
export function PanelOverflowKindView({ report }: { report: Report }) {
  const parsed = PanelOverflowPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;

  return (
    <Inline gap="xs">
      <Badge variant="warning" mono>
        +{Math.round(d.contentWidth - d.panelWidth)}px
      </Badge>
      <span className="truncate" title={d.label}>
        {d.label} · {d.page}
      </span>
      <span className="text-muted-foreground truncate" title={d.message}>
        {d.offender}
      </span>
    </Inline>
  );
}
