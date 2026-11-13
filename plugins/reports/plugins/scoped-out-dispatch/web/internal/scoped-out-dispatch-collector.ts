import type { ScopedOutDispatchFault } from "@plugins/primitives/plugins/slot-render/web";
import { report } from "@plugins/reports/web";
import type { ScopedOutDispatchPayload } from "@plugins/reports/plugins/scoped-out-dispatch/core";

// The handler of slot-render's `scopedOutDispatchSink`, drained through a
// `ReportSinks.Collector` keyed by `primitives.slot-render` (so it ships only
// where slot-render does). slot-render must not import `reports`, so
// `.Dispatch` emits its scoped-out fallbacks into a module-level sink; this
// files each as a `kind: "scoped-out-dispatch"` report. The sink has one
// handler for the whole page, so what it reports is the page's own
// observation, sent over the page's telemetry route.
export function collectScopedOutDispatch(f: ScopedOutDispatchFault): void {
  const data = {
    ...f,
    message: `In the "${f.scope}" scope, ${f.slotId} rendered its fallback for "${f.key}"; ${f.plugin} serves it on this page but is not in the scope.`,
  } satisfies ScopedOutDispatchPayload;
  void report({
    kind: "scoped-out-dispatch",
    source: "client-scoped-out-dispatch",
    message: `Scoped-out dispatch: ${data.message}`,
    url: window.location.href,
    userAgent: navigator.userAgent,
    data,
  });
}
