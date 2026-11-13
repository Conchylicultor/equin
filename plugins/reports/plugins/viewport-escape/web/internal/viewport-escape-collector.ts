import type { ViewportEscapeFault } from "@plugins/primitives/plugins/css/plugins/viewport-overlay/web";
import { report } from "@plugins/reports/web";
import type { ViewportEscapePayload } from "@plugins/reports/plugins/viewport-escape/core";

// The handler of the viewport-overlay primitive's `viewportEscapeReportSink`,
// drained through a `ReportSinks.Collector` keyed by
// `primitives.css.viewport-overlay` (so it ships only where the primitive
// does). The primitive must not import `reports`, so it emits a neutral
// `ViewportEscapeFault` into a module-level sink; this owns the mapping from
// that body to a `kind: "viewport-escape"` report — the same inversion crash
// uses for error-boundary's boundaryReportSink.
//
// Until this existed the sink had NO consumer, and a `defineReportSink` that
// nothing registers never delivers (it only holds its first reports). The auditor throws in dev, so during
// development it is loud; in production every fault it found was emitted into
// nothing. That is precisely backwards — a clipped fullscreen or a rail painting
// over the app is exactly the kind of "it looks almost right" bug that only ever
// shows up on someone else's machine.
export function collectViewportEscape(d: ViewportEscapeFault): void {
  // `satisfies` is the compile-time pin between the primitive's
  // `ViewportEscapeFaultKind` and the duplicated enum in this plugin's core
  // (which cannot import a web-runtime type — see the schema's comment).
  // This mapping is the one place that imports both, so a fault kind added
  // to the primitive fails to typecheck HERE rather than 400-ing at ingest.
  const data = {
    fault: d.kind,
    subject: d.subject,
    blocker: d.blocker,
    message: d.message,
  } satisfies ViewportEscapePayload;
  void report({
    kind: "viewport-escape",
    source: "client-viewport-escape",
    message: `Viewport escape (${d.subject}) — ${d.kind}: ${d.message}`,
    url: window.location.href,
    userAgent: navigator.userAgent,
    data,
  });
}
