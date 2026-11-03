import { useEffect } from "react";
import { httpStaleDropReportSink } from "@plugins/network/plugins/live/plugins/live-state/web";
import { report } from "@plugins/reports/web";

// A Core.Root side-effect component. `live-state` is a primitive and must not
// import `reports`, so `fetchOverHttp` emits a neutral HttpStaleDropReport into a
// module-level sink on EVERY dropped body (policy-free, carrying a running
// consecutive-drop count); this component owns the mapping from that body to a
// `kind: "live-state-stale-drop"` report — exactly the inversion crash uses for
// error-boundary's boundaryReportSink. Renders nothing.
//
// THE THRESHOLD LIVES HERE. We file a report only on the exact instant the third
// consecutive drop lands while the query still holds only its placeholder
// (`consecutiveDrops === 3 && neverApplied`). Exact-equals — not `>=` — so one
// wedge episode files exactly one report; the primitive's per-key counter resets
// to zero on any successful apply, which re-arms this for the next genuine wedge.
export function LiveStateStaleDropCollector() {
  useEffect(() => {
    httpStaleDropReportSink.register((d) => {
      if (!(d.consecutiveDrops === 3 && d.neverApplied)) return;
      void report({
        kind: "live-state-stale-drop",
        source: "client-live-state-stale-drop",
        message: `Live-state stale drop: ${d.key} wedged after ${d.consecutiveDrops} consecutive ${d.reason} drops`,
        url: window.location.href,
        userAgent: navigator.userAgent,
        data: d as unknown as Record<string, unknown>,
      });
    });

    return () => {
      httpStaleDropReportSink.register(null);
    };
  }, []);

  return null;
}
