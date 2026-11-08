import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import {
  PopoverAnchorLostPayloadSchema,
  type PopoverAnchorLostPayload,
} from "@plugins/reports/plugins/popover-anchor-lost/core";

// One-line Debug → Reports summary: why the anchor was lost, which anchor, and
// who hid it. Keyed on the cause union, so a new cause cannot ship unlabelled.
const LABEL: Record<PopoverAnchorLostPayload["cause"], string> = {
  detached: "removed",
  "no-box": "hidden",
};

export function PopoverAnchorLostKindView({ report }: { report: Report }) {
  const parsed = PopoverAnchorLostPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;

  return (
    <Inline gap="xs">
      <Badge variant="warning" mono>
        {LABEL[d.cause]}
      </Badge>
      <span className="truncate" title={d.anchor.path}>
        {d.anchor.element}
      </span>
      {d.hiddenBy && (
        <span
          className="text-muted-foreground truncate"
          title={d.hiddenBy.path}
        >
          by {d.hiddenBy.element}
        </span>
      )}
    </Inline>
  );
}
