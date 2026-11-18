import { optimisticRejectionSink } from "@plugins/network/plugins/live/web";
import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";
import { report } from "@plugins/reports/web";

// The sink's body: `OptimisticRejectionReport`, which `network/live`'s public
// barrel does not name.
export type OptimisticRejectionReport = Parameters<
  NonNullable<Parameters<typeof optimisticRejectionSink.register>[0]>
>[0];

/**
 * The rejections to toast, handed from the collector (a module-level sink
 * drain, no hook in reach) to `RejectionToasts` (a page-root component, where
 * `useToast` — the toast that is also recorded in the notification history —
 * lives). A report sink, so a rejection emitted before the component mounts
 * is held and replayed to it, never dropped.
 */
export const rejectionToastSink = defineReportSink<OptimisticRejectionReport>();

// The handler of `network/live`'s `optimisticRejectionSink`, drained through a
// `ReportSinks.Collector` keyed by `network.live` (so it ships only where
// `network/live` does). The write primitive (optimistic-mutation) must not
// import `reports` or `shell`, so it emits a neutral OptimisticRejectionReport
// into the module-level sink; this owns what a rejection means to the user (a
// toast: the edit is gone, and why — raised by `RejectionToasts`) and to the
// developer (a `kind: "optimistic-rejection"` report).
export function collectOptimisticRejection(d: OptimisticRejectionReport): void {
  rejectionToastSink.emit(d);
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
}
