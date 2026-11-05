import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import {
  BootWedgePayloadSchema,
  describeBootPhases,
  humanMs,
  type BootWedgePayload,
} from "../../core";

const HEADLINE: Record<BootWedgePayload["state"], string> = {
  booting: "still booting",
  failed: "unusable — boot killed before ready",
  killed: "boot killed before ready",
  "restart-failed": "deploy failed — new backend killed before ready",
  superseded: "never became ready, then superseded",
  open: "never became ready",
};

// One-line boot-wedge summary for the Debug → Reports list, e.g.
// "`agent-42` unusable — boot killed before ready · 3h · in
// onReadyBlocking:config_v2 at 77s (imports 62s; …)". The worktree renders as
// a destructive-colored mono chip; what is true now, for how long, and where
// the boot's time went trail.
export function BootWedgeSummary({ report }: { report: Report }) {
  const parsed = BootWedgePayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;
  const phases = describeBootPhases(d.journal);

  return (
    <Inline gap="xs">
      <Badge variant="destructive" mono>
        {d.worktree}
      </Badge>
      <span>
        {HEADLINE[d.state]} · {humanMs(d.wedgedMs)}
      </span>
      {phases !== null && (
        <span className="text-muted-foreground">{phases}</span>
      )}
    </Inline>
  );
}
