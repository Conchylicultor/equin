import type { ReactElement } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  REPORT_FIX_STATE_LABELS,
  reportFields,
  type Report,
} from "@plugins/reports/core";

// The field's own option tints (core/entity.ts), so the badge and the
// Status filter's chips cannot disagree.
const OPTIONS = reportFields.fixState.meta.optionMeta;

/**
 * Where a report stands against its fix — Open draws nothing (the default,
 * unremarkable) — with the fix's commit beside any other state.
 */
export function FixStateBadge({
  report,
}: {
  report: Pick<Report, "fixState" | "fixCommit">;
}): ReactElement | null {
  if (report.fixState === "open") return null;
  return (
    <Cluster gap="xs">
      <Badge variant={OPTIONS?.[report.fixState]?.variant ?? "muted"}>
        {REPORT_FIX_STATE_LABELS[report.fixState]}
      </Badge>
      {report.fixCommit !== null && (
        <Text variant="caption" tone="muted" className="font-mono">
          {report.fixCommit.slice(0, 9)}
        </Text>
      )}
    </Cluster>
  );
}
