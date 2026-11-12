import { useEffect } from "react";
import { toolInputDriftSink } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { report } from "@plugins/reports/web";
import type { ToolInputDriftPayload } from "@plugins/reports/plugins/tool-input-drift/core";

// A Core.Root side-effect component. tool-call must not import `reports`, so a
// tool renderer emits the drift it sees into a module-level sink; this
// component files each as a `kind: "tool-input-drift"` report. Renders nothing.
export function ToolInputDriftCollector() {
  useEffect(() => {
    toolInputDriftSink.register((d) => {
      const data = {
        ...d,
        message: `${d.tool} took an input its transcript card's schema rejects:\n${d.issues}`,
      } satisfies ToolInputDriftPayload;
      void report({
        kind: "tool-input-drift",
        source: "client-tool-input-drift",
        message: `Tool input drift: ${data.message}`,
        url: window.location.href,
        userAgent: navigator.userAgent,
        data,
      });
    });
    return () => {
      toolInputDriftSink.register(null);
    };
  }, []);

  return null;
}
