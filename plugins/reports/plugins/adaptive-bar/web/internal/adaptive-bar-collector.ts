import type { AdaptiveBarFault } from "@plugins/primitives/plugins/adaptive-bar/web";
import { report } from "@plugins/reports/web";
import type { AdaptiveBarPayload } from "@plugins/reports/plugins/adaptive-bar/core";

// The handler of the adaptive-bar primitive's `adaptiveBarReportSink`, drained
// through a `ReportSinks.Collector` keyed by `primitives.adaptive-bar` (so it
// ships only where the primitive does). The primitive must not import
// `reports`, so it emits a neutral `AdaptiveBarFault` into a module-level sink;
// this owns the mapping from that body to a `kind: "adaptive-bar"` report —
// exactly the inversion crash uses for error-boundary's boundaryReportSink.
//
// Until this existed the sink had NO consumer, and a `defineReportSink` that
// nothing registers never delivers (it only holds its first reports): every adaptive-bar layout fault in
// production was dropped on the floor, while the primitive's own docs promised a
// filed report. That is how a fit-vs-layout disagreement was able to take the
// whole Debug → Layout Lab pane down without a single row appearing anywhere.
//
// NO THRESHOLD HERE, deliberately. The primitive already refuses to report the
// normal case at the source: running out of room and relocating widgets is what
// the bar is FOR and never reaches the sink. Every body that arrives is a broken
// premise — one report each, deduped server-side by (fault, origin, overflow).
export function collectAdaptiveBar(d: AdaptiveBarFault): void {
  // `satisfies` is the compile-time pin between the primitive's own fault
  // body — `AdaptiveBarFaultKind`, `AdaptiveBarOverflow`,
  // `ConvergenceEvidence` — and the duplicated spellings in this plugin's
  // core, which cannot import a web-runtime type (see the schema's
  // comment). This mapping is the one place that imports both, so a fault
  // kind, an overflow mode or an evidence field that is added, renamed,
  // retyped or removed on the primitive fails to typecheck HERE rather than
  // 400-ing at ingest. (One direction only: a field ADDED to
  // `ConvergenceEvidence` is silently not carried until it is added below,
  // because a wider value stays assignable to a narrower type.)
  const data = {
    fault: d.kind,
    label: d.label,
    origin: d.origin,
    originPath: d.originPath,
    overflow: d.overflow,
    message: d.message,
    item: d.item,
    evidence: d.evidence,
  } satisfies AdaptiveBarPayload;
  void report({
    kind: "adaptive-bar",
    source: "client-adaptive-bar",
    // Named by its origin where there is one: `label` defaults to "More"
    // and several unrelated bars answer to it, so leading with it makes two
    // different findings read as the same line in the bell.
    message: `Adaptive bar (${d.origin ?? d.label}) — ${d.kind}: ${d.message}`,
    url: window.location.href,
    userAgent: navigator.userAgent,
    data,
  });
}
