import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { appLink } from "@plugins/apps-core/plugins/tabs/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { traceDetailRoute } from "@plugins/debug/plugins/trace/plugins/engine/core";
import { StuckSpanPayloadSchema } from "../../core";
import { describeChain, formatAge } from "../../shared/message";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const boltIcon = symbol("bolt");

// One-line span-stuck summary for the Debug → Reports list, e.g.
// "[stuck] still running after 3 min: flush flushNotifies → push
// conversations-gone:count", plus a View-trace chip onto everything that was in
// flight when it was detected. The destructive chip is what separates it at a
// glance from a slow-op row: that one finished slowly, this one had not
// finished at all.
export function SpanStuckSummary({ report }: { report: Report }) {
  const parsed = StuckSpanPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;
  const traceId = d.traceId;

  return (
    <Inline gap="xs">
      <Badge variant="destructive">stuck</Badge>
      <span>still running after {formatAge(d.ageMs)}:</span>
      <Badge mono>{describeChain(d)}</Badge>
      {traceId !== null && (
        <LinkChip
          leading={<Icon icon={boltIcon} className="icon-auto" />}
          activation={appLink(traceDetailRoute.link(debugApp, { id: traceId }))}
        >
          View trace
        </LinkChip>
      )}
    </Inline>
  );
}
