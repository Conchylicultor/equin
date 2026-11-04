import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { useAppLink } from "@plugins/apps-core/plugins/tabs/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { traceDetailRoute } from "@plugins/debug/plugins/trace/plugins/engine/core";
import { isInTransaction } from "@plugins/database/plugins/connection/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { DbQueryDeadlinePayloadSchema } from "../../core";
import { formatDurationMs } from "../../shared/format-duration";

// One-line summary for the Debug → Reports list, e.g.
//   [jobs-enqueue] [query] [select … from jobs] no answer for 60s — abandoned · issued by tasks.maybe-launch
//   [app] [connect] no answer for 60s — abandoned · issued by push tasks
// The pool and phase lead as muted chips (they say which connection and what it
// was doing), the query label is a destructive mono chip that truncates, and
// the caller trails, muted. A connect has no query to show. Then the evidence:
// an `in tx` chip when the call was sent inside a transaction (its locks stay
// held), how many other calls were waiting, and a View-trace chip.

const boltIcon = symbol("bolt");

export function QueryDeadlineSummary({ report }: { report: Report }) {
  const inAppLink = useAppLink();
  const parsed = DbQueryDeadlinePayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;

  return (
    <Inline gap="xs">
      <Badge mono tooltip={`Connection pool: ${d.pool}`}>
        {d.pool}
      </Badge>
      <Badge
        variant={d.phase === "connect" ? "warning" : "muted"}
        tooltip={
          d.phase === "connect"
            ? "Opening the connection got no reply"
            : "A query on an open connection got no reply"
        }
      >
        {d.phase === "connect" ? "connect" : "query"}
      </Badge>
      {d.phase === "query" && (
        <Badge variant="destructive" mono tooltip={d.sql}>
          {d.sql}
        </Badge>
      )}
      <span>no answer for {formatDurationMs(d.elapsedMs)} — abandoned</span>
      {d.origin !== null && (
        <span className="text-muted-foreground">· issued by {d.origin}</span>
      )}
      {isInTransaction(d.transaction) && (
        <Badge
          variant="warning"
          tooltip="Sent inside a transaction: abandoned, it is never rolled back, so its row locks stay held"
        >
          in tx
        </Badge>
      )}
      {d.inFlightCount !== null && d.inFlightCount > 0 && (
        <span className="text-muted-foreground">
          · {d.inFlightCount} other call{d.inFlightCount === 1 ? "" : "s"}{" "}
          waiting
        </span>
      )}
      {d.traceId !== null && (
        <LinkChip
          leading={<Icon icon={boltIcon} className="icon-auto" />}
          activation={inAppLink(
            traceDetailRoute.link(debugApp, { id: d.traceId }),
          )}
        >
          View trace
        </LinkChip>
      )}
    </Inline>
  );
}
