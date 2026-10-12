import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { appLink } from "@plugins/apps-core/plugins/tabs/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { traceDetailRoute } from "@plugins/debug/plugins/trace/plugins/engine/core";
import { StallPayloadSchema } from "../../core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const boltIcon = symbol("bolt");

// One-line event-loop-stall summary for the Debug → Reports list, e.g.
// "`parseTranscript @ …` — 4200ms", plus a View-trace chip deep-linking the
// coherent-instant stall evidence when captureTrace admitted one.
export function StallSummary({ report }: { report: Report }) {
  const parsed = StallPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;

  return (
    <Inline gap="xs">
      <Badge variant="destructive" mono>
        {d.hotFrame}
      </Badge>
      <span>— {Math.round(d.durationMs)}ms</span>
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
