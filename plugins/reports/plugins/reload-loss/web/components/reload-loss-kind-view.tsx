import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { ReloadLossPayloadSchema } from "@plugins/reports/plugins/reload-loss/core";

// One-line Debug → Reports summary: which component lost which state, where.
export function ReloadLossKindView({ report }: { report: Report }) {
  const parsed = ReloadLossPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;
  return (
    <Inline gap="xs">
      <Badge variant="warning" mono>
        {d.origin}
      </Badge>
      <span className="truncate" title={d.owners.join(" › ")}>
        {d.component} #{d.stateIndex}
      </span>
      <span className="text-muted-foreground truncate" title={d.source}>
        {d.value}
      </span>
    </Inline>
  );
}
