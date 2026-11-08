import { useEffect } from "react";
import { scopedOutDispatchSink } from "@plugins/primitives/plugins/slot-render/web";
import { report } from "@plugins/reports/web";
import type { ScopedOutDispatchPayload } from "@plugins/reports/plugins/scoped-out-dispatch/core";

// A Core.Root side-effect component. slot-render must not import `reports`, so
// `.Dispatch` emits its scoped-out fallbacks into a module-level sink; this
// component files each as a `kind: "scoped-out-dispatch"` report. Mounted by
// the page, outside every scope: what it reports is the page's own
// observation, sent over the page's telemetry route. Renders nothing.
export function ScopedOutDispatchCollector() {
  useEffect(() => {
    scopedOutDispatchSink.register((f) => {
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
    });
    return () => {
      scopedOutDispatchSink.register(null);
    };
  }, []);

  return null;
}
