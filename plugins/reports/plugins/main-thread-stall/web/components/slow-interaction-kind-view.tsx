import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import {
  dominantLayer,
  interactionTargetLabel,
  SlowInteractionPayloadSchema,
} from "../../core";

// One-line Debug → Reports summary: how long input → paint took, what was
// interacted with, and where most of it went (with what forced it).
export function SlowInteractionKindView({ report }: { report: Report }) {
  const parsed = SlowInteractionPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;
  const top = dominantLayer(d.breakdown);
  const who = top.layer === "forced style/layout" ? d.forcedBy : d.topFunction;

  return (
    <Inline gap="xs">
      <Badge variant={d.durationMs >= 800 ? "destructive" : "warning"} mono>
        {d.durationMs} ms
      </Badge>
      <span className="truncate font-mono" title={d.url}>
        {interactionTargetLabel(d.target)}
      </span>
      <span className="truncate text-muted-foreground font-mono">
        {top.layer} {top.ms} ms{who ? ` · ${who}` : ""}
      </span>
    </Inline>
  );
}
