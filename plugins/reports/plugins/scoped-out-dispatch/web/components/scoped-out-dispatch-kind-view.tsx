import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { ScopedOutDispatchPayloadSchema } from "@plugins/reports/plugins/scoped-out-dispatch/core";

// One-line Debug → Reports summary: the scope, and the plugin it left out.
export function ScopedOutDispatchKindView({ report }: { report: Report }) {
  const parsed = ScopedOutDispatchPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;

  return (
    <Inline gap="xs">
      <Badge variant="warning" mono>
        {d.scope}
      </Badge>
      <span className="truncate" title={d.slotId}>
        {d.plugin}
      </span>
      <span className="text-muted-foreground truncate">for {d.key}</span>
    </Inline>
  );
}
