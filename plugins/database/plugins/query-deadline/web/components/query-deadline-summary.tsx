import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { TraceChip } from "@plugins/debug/plugins/trace/plugins/engine/web";
import { isInTransaction } from "@plugins/database/plugins/connection/core";
import { DbQueryDeadlinePayloadSchema } from "../../core";
import { formatDurationMs } from "../../shared/format-duration";

// One-line summary for the Debug → Reports list, e.g.
//   [jobs-enqueue] [query] [select … from jobs] no answer for 60s — closed · issued by tasks.maybe-launch
//   [app] [connect] no answer for 60s — closed · issued by push tasks
// The pool and phase lead as muted chips (they say which connection and what it
// was doing), the query label is a destructive mono chip that truncates, and
// the caller trails, muted. A connect has no query to show. Then the evidence:
// an `in tx` chip when the call was sent inside a transaction (its locks stay
// held), how many other calls were waiting, and a View-trace chip.

export function QueryDeadlineSummary({ report }: { report: Report }) {
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
      <span>no answer for {formatDurationMs(d.elapsedMs)} — closed</span>
      {d.origin !== null && (
        <span className="text-muted-foreground">· issued by {d.origin}</span>
      )}
      {isInTransaction(d.transaction) && (
        <Badge
          variant="warning"
          tooltip="Sent inside a transaction, which closing the connection rolled back"
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
      {d.traceId !== null && <TraceChip traceId={d.traceId} />}
    </Inline>
  );
}
