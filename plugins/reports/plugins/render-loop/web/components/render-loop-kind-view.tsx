import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { RenderLoopPayloadSchema } from "@plugins/reports/plugins/render-loop/core";

// One-line Debug → Reports summary for the render-loop kind (previously fell back
// to the raw message): the mutation class + the culprit signature + the sustained
// rate. No trace — a render loop is a client-DOM signal, not a server flight
// window.
export function RenderLoopKindView({ report }: { report: Report }) {
  const parsed = RenderLoopPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;

  return (
    <Inline gap="xs">
      <Badge variant="warning" mono>
        {d.mutationClass}
      </Badge>
      <span className="truncate font-mono" title={d.signature}>
        {d.signature}
      </span>
      <span className="text-muted-foreground tabular-nums">
        ~{Math.round(d.ratePerSec)}/s for {Math.round(d.sustainedMs / 1000)}s
      </span>
      {d.initiators?.length === 0 ? (
        <span className="text-muted-foreground">no React re-render</span>
      ) : d.initiators?.[0] ? (
        <span className="truncate text-muted-foreground">
          by {d.initiators[0].component}
        </span>
      ) : null}
    </Inline>
  );
}
