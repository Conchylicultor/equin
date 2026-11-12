import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { IconMissingGlyphPayloadSchema } from "@plugins/reports/plugins/icon-missing-glyph/core";

// One-line Debug → Reports summary for the icon-missing-glyph kind: which
// sprite, and the symbol it lacks.
export function IconMissingGlyphKindView({ report }: { report: Report }) {
  const parsed = IconMissingGlyphPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;

  return (
    <Inline gap="xs">
      <Badge variant="destructive" mono>
        {d.sprite}
      </Badge>
      <span className="truncate">no symbol {d.id}</span>
    </Inline>
  );
}
