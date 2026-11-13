import type { IconFamilyGap } from "@plugins/ui/plugins/icons/web";
import { report } from "@plugins/reports/web";
import type { IconFamilyGapPayload } from "@plugins/reports/plugins/icon-family-gap/core";

// The handler of the icons plugin's `iconFamilyGapReportSink`, drained through
// a `ReportSinks.Collector` keyed by `ui.icons` (so it ships only where the
// icons plugin does). The icons plugin is a leaf below the ui-kit and must not
// import `reports`, so `<Icon>` emits a neutral `IconFamilyGap` into a
// module-level sink (once per family and name per page); this owns the mapping
// to a `kind: "icon-family-gap"` report — the same inversion theme-resolution
// uses.
export function collectIconFamilyGap(gap: IconFamilyGap): void {
  // `satisfies` pins the icons plugin's gap to this plugin's core schema,
  // which cannot import a web-runtime type.
  const data = {
    family: gap.family,
    name: gap.name,
  } satisfies IconFamilyGapPayload;
  void report({
    kind: "icon-family-gap",
    source: "client-icon-family-gap",
    message: `Icon family "${gap.family}" (strict) has no glyph for "${gap.name}"`,
    url: window.location.href,
    userAgent: navigator.userAgent,
    data,
  });
}
