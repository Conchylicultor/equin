import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { ToolInputDriftPayloadSchema } from "@plugins/reports/plugins/tool-input-drift/core";

// One-line Debug → Reports summary: the tool, and the first issue.
export function ToolInputDriftKindView({ report }: { report: Report }) {
  const parsed = ToolInputDriftPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;

  return (
    <Inline gap="xs">
      <Badge variant="warning" mono>
        {d.tool}
      </Badge>
      <span className="text-muted-foreground truncate" title={d.issues}>
        {d.issues.split("\n", 1)[0]}
      </span>
    </Inline>
  );
}
