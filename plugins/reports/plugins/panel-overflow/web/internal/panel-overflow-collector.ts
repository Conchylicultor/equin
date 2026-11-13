import type { PanelOverflowFault } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { report } from "@plugins/reports/web";
import type { PanelOverflowPayload } from "@plugins/reports/plugins/panel-overflow/core";

// The handler of the control-panel primitive's `panelOverflowReportSink`,
// drained through a `ReportSinks.Collector` keyed by
// `primitives.css.control-panel` (so it ships only where the primitive does).
// The control-panel primitive must not import `reports`, so it emits a neutral
// `PanelOverflowFault` into a module-level sink; this owns the mapping from
// that body to a `kind: "panel-overflow"` report — the same inversion
// viewport-escape uses.
export function collectPanelOverflow(d: PanelOverflowFault): void {
  // `satisfies` pins the primitive's fault to this plugin's core schema,
  // which cannot import a web-runtime type.
  const data = {
    label: d.label,
    page: d.page,
    needs: [...d.needs],
    panelWidth: d.panelWidth,
    contentWidth: d.contentWidth,
    offender: d.offender,
    message: d.message,
  } satisfies PanelOverflowPayload;
  void report({
    kind: "panel-overflow",
    source: "client-panel-overflow",
    message: `Panel overflow (${d.label} / ${d.page}): ${d.message}`,
    url: window.location.href,
    userAgent: navigator.userAgent,
    data,
  });
}
