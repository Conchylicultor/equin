import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { LiveSetOverBudgetPayloadSchema } from "../../core";

// One-line Debug → Reports summary: the set's key, then rows / budget.
export function OverBudgetKindView({ report }: { report: Report }) {
  const parsed = LiveSetOverBudgetPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;
  return (
    <Inline gap="xs">
      <Badge variant="warning" mono>
        {d.key}
      </Badge>
      <span>
        {d.rows} rows · budget {d.budget}
      </span>
    </Inline>
  );
}
