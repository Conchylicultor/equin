import type { HttpStaleDropReport } from "@plugins/network/plugins/live/plugins/live-state/web";
import { report } from "@plugins/reports/web";

// The handler of the live-state primitive's `httpStaleDropReportSink`, drained
// through a `ReportSinks.Collector` keyed by `network.live.live-state` (so it
// ships only where live-state does). `live-state` is a primitive and must not
// import `reports`, so `fetchOverHttp` emits a neutral HttpStaleDropReport into a
// module-level sink on EVERY dropped body (policy-free, carrying a running
// consecutive-drop count); this owns the mapping from that body to a
// `kind: "live-state-stale-drop"` report — exactly the inversion crash uses for
// error-boundary's boundaryReportSink.
//
// THE THRESHOLD LIVES HERE. We file a report only on the exact instant the third
// consecutive drop lands while the query still holds only its placeholder
// (`consecutiveDrops === 3 && neverApplied`). Exact-equals — not `>=` — so one
// wedge episode files exactly one report; the primitive's per-key counter resets
// to zero on any successful apply, which re-arms this for the next genuine wedge.
export function collectStaleDrop(d: HttpStaleDropReport): void {
  if (!(d.consecutiveDrops === 3 && d.neverApplied)) return;
  void report({
    kind: "live-state-stale-drop",
    source: "client-live-state-stale-drop",
    message: `Live-state stale drop: ${d.key} wedged after ${d.consecutiveDrops} consecutive ${d.reason} drops`,
    url: window.location.href,
    userAgent: navigator.userAgent,
    data: d as unknown as Record<string, unknown>,
  });
}
