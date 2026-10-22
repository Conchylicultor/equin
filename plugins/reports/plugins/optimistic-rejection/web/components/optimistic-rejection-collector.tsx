import { useEffect } from "react";
import { optimisticRejectionSink } from "@plugins/primitives/plugins/optimistic-mutation/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { report } from "@plugins/reports/web";

// A Core.Root side-effect component. The optimistic-mutation primitive must not
// import `reports` or `shell`, so it emits a neutral OptimisticRejectionReport
// into a module-level sink; this component owns what a rejection means to the
// user (a toast: the edit is gone, and why) and to the developer (a
// `kind: "optimistic-rejection"` report). Renders nothing.
export function OptimisticRejectionCollector() {
  useEffect(() => {
    optimisticRejectionSink.register((d) => {
      showToast({
        variant: "error",
        title: d.label
          ? `Couldn't save ${d.label.toLowerCase()} edit`
          : "Couldn't save edit",
        description: d.message,
      });
      // Main refused an agent session's write by design (main is read-only for
      // agents): the toast tells the agent why, and there is nothing to
      // investigate — a report per refused click would be a storm of non-bugs.
      if (d.agentWriteRefused) return;
      const { agentWriteRefused: _refused, ...payload } = d;
      const what = d.label ? `${d.resourceKey}/${d.label}` : d.resourceKey;
      const op = d.opSummary ? ` (${d.opSummary})` : "";
      void report({
        kind: "optimistic-rejection",
        source: "client-optimistic-rejection",
        message: `Write rejected with HTTP ${d.status}: ${what}${op} — ${d.message}`,
        url: window.location.href,
        userAgent: navigator.userAgent,
        data: payload as unknown as Record<string, unknown>,
      });
    });

    return () => {
      optimisticRejectionSink.register(null);
    };
  }, []);

  return null;
}
