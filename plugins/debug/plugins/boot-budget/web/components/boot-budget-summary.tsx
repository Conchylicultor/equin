import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { BootBudgetPayloadSchema } from "../../core";

// One-line boot-budget summary for the Debug → Reports list, e.g.
// "`onReady:stats/cost` — 3200ms boot (budget 500ms)". The span name renders as a
// warning-colored mono chip; the duration vs budget trails.
export function BootBudgetSummary({ report }: { report: Report }) {
  const parsed = BootBudgetPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;

  return (
    <Inline gap="xs">
      <Badge variant="warning" mono>
        {d.spanName}
      </Badge>
      <span>
        — {d.durationMs}ms boot
      </span>
      <span className="text-muted-foreground">
        ({d.budgetSource === "declared" ? "declared budget" : "budget"}{" "}
        {d.budgetMs}ms)
      </span>
    </Inline>
  );
}
