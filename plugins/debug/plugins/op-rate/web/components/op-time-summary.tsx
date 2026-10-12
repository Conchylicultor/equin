import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { appLink } from "@plugins/apps-core/plugins/tabs/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { traceDetailRoute } from "@plugins/debug/plugins/trace/plugins/engine/core";
import { OpTimePayloadSchema } from "../../core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const boltIcon = symbol("bolt");

// One-line aggregate-time summary for the Debug → Reports list, e.g.
// "`db select-tasks` — 42.0s/window across 6204 calls (budget 60.0s)", plus a
// View-trace chip deep-linking the coherent-instant evidence when the per-op trip
// captured one. Rollup rows (no `label`) read "rollup: <kind>" and carry no trace.
export function OpTimeSummary({ report }: { report: Report }) {
  const parsed = OpTimePayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;

  const secs = (d.msInWindow / 1000).toFixed(1);
  const budgetSecs = (d.budgetMs / 1000).toFixed(1);

  return (
    <Inline gap="xs">
      <Badge variant="warning" mono>
        {d.label ? `${d.kind}:${d.label}` : `rollup:${d.kind}`}
      </Badge>
      <span>
        — {secs}s/window across {d.callsInWindow} calls
      </span>
      <span className="text-muted-foreground">(budget {budgetSecs}s)</span>
      {d.traceId && (
        <LinkChip
          leading={<Icon icon={boltIcon} className="icon-auto" />}
          activation={appLink(
            traceDetailRoute.link(debugApp, { id: d.traceId! }),
          )}
        >
          View trace
        </LinkChip>
      )}
    </Inline>
  );
}
