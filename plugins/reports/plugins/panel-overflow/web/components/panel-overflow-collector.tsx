import { useEffect } from "react";
import { panelOverflowReportSink } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { report } from "@plugins/reports/web";
import type { PanelOverflowPayload } from "@plugins/reports/plugins/panel-overflow/core";

// A Core.Root side-effect component. The control-panel primitive must not
// import `reports`, so it emits a neutral `PanelOverflowFault` into a
// module-level sink; this component owns the mapping from that body to a
// `kind: "panel-overflow"` report — the same inversion viewport-escape uses.
// Renders nothing.
export function PanelOverflowCollector() {
  useEffect(() => {
    panelOverflowReportSink.register((d) => {
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
    });

    return () => {
      panelOverflowReportSink.register(null);
    };
  }, []);

  return null;
}
