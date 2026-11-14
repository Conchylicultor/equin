import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import {
  interactionTargetLabel,
  MainThreadStallPayloadSchema,
} from "../../core";

// One-line Debug → Reports summary: how the stall ended, how long, where (app +
// route pattern), the interaction it started from, what ran (or `unattributed`),
// the heaviest sampled function, and how many tabs froze with it.
export function MainThreadStallKindView({ report }: { report: Report }) {
  const parsed = MainThreadStallPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;
  const secs = (d.durationMs / 1000).toFixed(1);

  return (
    <Inline gap="xs">
      <Badge variant={d.ended === "recovered" ? "warning" : "destructive"} mono>
        {d.ended}
      </Badge>
      <span className="tabular-nums">
        {d.durationIsLowerBound ? "≥" : ""}
        {secs}s
      </span>
      {d.interaction && (
        <span className="truncate font-mono">
          {interactionTargetLabel(d.interaction.target)}
        </span>
      )}
      <span className="truncate font-mono" title={d.url}>
        {d.app ?? "?"} {d.routePattern}
      </span>
      <span className="truncate text-muted-foreground font-mono">
        {d.topFunction ?? "unattributed"}
      </span>
      {d.stacks.kind === "sampled" && d.stacks.topSelf[0] && (
        <span
          className="truncate font-mono"
          title={`sampled: ${d.stacks.topSelf[0].ms} ms self`}
        >
          {d.stacks.topSelf[0].frame}
        </span>
      )}
      {d.frozenIn && (
        <span className="truncate font-mono" title={d.frozenIn.detail}>
          {d.frozenIn.source} {d.frozenIn.what}
        </span>
      )}
      {d.cohort.length > 0 && (
        <span className="text-muted-foreground">+{d.cohort.length} tabs</span>
      )}
    </Inline>
  );
}
