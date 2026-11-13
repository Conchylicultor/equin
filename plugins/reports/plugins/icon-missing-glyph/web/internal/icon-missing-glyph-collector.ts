import type { IconMissingGlyph } from "@plugins/ui/plugins/icons/web";
import { report } from "@plugins/reports/web";
import type { IconMissingGlyphPayload } from "@plugins/reports/plugins/icon-missing-glyph/core";

// The handler of the icons plugin's `iconMissingGlyphReportSink`, drained
// through a `ReportSinks.Collector` keyed by `ui.icons` (so it ships only where
// the icons plugin does). The icons plugin is a leaf below the ui-kit and must
// not import `reports`, so `<Icon>` emits a neutral `IconMissingGlyph` into a
// module-level sink (once per sprite and symbol per page); this owns the
// mapping to a `kind: "icon-missing-glyph"` report.
export function collectIconMissingGlyph(missing: IconMissingGlyph): void {
  // `satisfies` pins the icons plugin's body to this plugin's core schema,
  // which cannot import a web-runtime type.
  const data = {
    sprite: missing.sprite,
    id: missing.id,
  } satisfies IconMissingGlyphPayload;
  void report({
    kind: "icon-missing-glyph",
    source: "client-icon-missing-glyph",
    message: `Icon sprite "${missing.sprite}" has no symbol "${missing.id}"`,
    url: window.location.href,
    userAgent: navigator.userAgent,
    data,
  });
}
