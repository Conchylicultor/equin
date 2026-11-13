import type { ThemeResolutionFault } from "@plugins/ui/plugins/theme-engine/web";
import { report } from "@plugins/reports/web";
import type { ThemeResolutionPayload } from "@plugins/reports/plugins/theme-resolution/core";

// The handler of theme-engine's `themeResolutionReportSink`, drained through a
// `ReportSinks.Collector` keyed by `ui.theme-engine` (so it ships only where
// the theme painter does). The theme painter must not import `reports`, so it
// emits a neutral `ThemeResolutionFault` into a module-level sink whenever a
// scope's theme cannot be painted as stored; this owns the mapping to a
// `kind: "theme-resolution"` report — the same inversion viewport-escape and
// collab-hydration use.
export function collectThemeResolution(fault: ThemeResolutionFault): void {
  // `satisfies` pins the painter's fault union to this plugin's payload
  // schema: a fault kind added to the painter fails to typecheck HERE
  // rather than 400-ing at ingest.
  const data = (
    fault.kind === "missing-theme"
      ? {
          fault: fault.kind,
          ...(fault.scopeId === undefined ? {} : { scopeId: fault.scopeId }),
          themeId: fault.themeId,
        }
      : fault.kind === "unregistered-group"
        ? {
            fault: fault.kind,
            themeId: fault.themeId,
            groupId: fault.groupId,
          }
        : {
            fault: fault.kind,
            themeId: fault.themeId,
            groupId: fault.groupId,
            tokens: fault.tokens,
          }
  ) satisfies ThemeResolutionPayload;
  void report({
    kind: "theme-resolution",
    source: "client-theme-resolution",
    message: `Theme resolution — ${fault.kind}: ${JSON.stringify(data)}`,
    url: window.location.href,
    userAgent: navigator.userAgent,
    data,
  });
}
