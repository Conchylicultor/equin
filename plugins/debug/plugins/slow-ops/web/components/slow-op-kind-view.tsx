import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { useAppLink } from "@plugins/apps-core/plugins/tabs/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { traceDetailRoute } from "@plugins/debug/plugins/trace/plugins/engine/core";
import { SlowOpReportPayloadSchema } from "@plugins/debug/plugins/slow-ops/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const boltIcon = symbol("bolt");

// One-line Debug → Reports summary for the slow-op kind (previously fell back to
// the raw message): `kind label — Nms (threshold Mms)`, plus a View-trace chip
// deep-linking the durable coherent-instant evidence when the trip captured one.
export function SlowOpKindView({ report }: { report: Report }) {
  const inAppLink = useAppLink();
  const parsed = SlowOpReportPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;

  return (
    <Inline gap="xs">
      <Badge variant="warning" mono>
        {d.operationKind}:{d.operation}
      </Badge>
      {d.burst && (
        <span>
          {d.burst.count} ops at once, slowest{" "}
          {d.burst.operations[0]?.operation}
        </span>
      )}
      <span>— {Math.round(d.ownMs ?? d.durationMs)}ms</span>
      <span className="text-muted-foreground">
        (threshold {Math.round(d.thresholdMs)}ms)
      </span>
      {d.traceId && (
        <LinkChip
          leading={<Icon icon={boltIcon} className="icon-auto" />}
          activation={inAppLink(
            traceDetailRoute.link(debugApp, { id: d.traceId! }),
          )}
        >
          View trace
        </LinkChip>
      )}
    </Inline>
  );
}
