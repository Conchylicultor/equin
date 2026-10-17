import { type ReactElement } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { incidentColorClass, type IncidentInfo } from "../internal/incidents";

// The Events list's incident chip: a colored dot (the incident's stable palette
// tint) + ×{size}. Rows co-occurring in one wall-clock window share a tint, so
// the (already-adjacent, newest-first) rows read as a visual cluster. The count
// is a LOWER BOUND — rate-limited siblings never persist — so the tooltip says
// groups may be incomplete.
export function IncidentBadge({
  info,
  windowSpanMs,
}: {
  info: IncidentInfo;
  windowSpanMs: number;
}): ReactElement {
  return (
    <Badge
      mono
      icon={<StatusDot colorClass={incidentColorClass(info.colorIndex)} />}
      tooltip={`${info.size} traces co-occur in this ~${Math.round(
        windowSpanMs / 1000,
      )}s window — groups may be incomplete (siblings can be rate-limited).`}
    >
      ×{info.size}
    </Badge>
  );
}
