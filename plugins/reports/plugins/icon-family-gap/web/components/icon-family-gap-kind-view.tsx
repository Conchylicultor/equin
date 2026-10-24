import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { IconFamilyGapPayloadSchema } from "@plugins/reports/plugins/icon-family-gap/core";

// One-line Debug → Reports summary for the icon-family-gap kind: which family,
// and the symbol it does not draw.
export function IconFamilyGapKindView({ report }: { report: Report }) {
  const parsed = IconFamilyGapPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;

  return (
    <Inline gap="xs">
      <Badge variant="warning" mono>
        {d.family}
      </Badge>
      <span className="truncate">no glyph for {d.name}</span>
    </Inline>
  );
}
