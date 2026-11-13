import type { ToolInputDrift } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { report } from "@plugins/reports/web";
import type { ToolInputDriftPayload } from "@plugins/reports/plugins/tool-input-drift/core";

// The handler of tool-call's `toolInputDriftSink`, drained through a
// `ReportSinks.Collector` keyed by
// `conversations.conversation-view.jsonl-viewer.tool-call` (so it ships only
// where tool-call does). tool-call must not import `reports`, so a tool
// renderer emits the drift it sees into a module-level sink; this files each
// as a `kind: "tool-input-drift"` report.
export function collectToolInputDrift(d: ToolInputDrift): void {
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
}
