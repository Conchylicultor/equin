import { captureTrace } from "@plugins/debug/plugins/trace/plugins/engine/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import {
  captureFlightWindow,
  profilerNowMs,
} from "@plugins/infra/plugins/runtime-profiler/core";
import type { StallSection } from "@plugins/debug/plugins/trace/plugins/stall/core";
import { deriveCulprit } from "./culprit";
import { classifyCoverage } from "./coverage";

// The alert side of an event-loop stall. health-monitor's sampler DETECTS +
// AGGREGATES the freeze (it drains the JSC profiler and builds the StallSection);
// it then hands the section here via a direct barrel call. This plugin owns BOTH
// the trace (evidence) and the report (alert) for a stall — exactly how op-rate's
// op-time kind owns both — so a frozen backend reaches the bell + Debug → Reports,
// linked to its trace. A direct call (not a defineReportSink fan-out) is correct:
// the consumer set is closed and singular, and health-monitor may hard-depend on
// this plugin. Mirrors op-rate / slow-ops, which call captureTrace + recordReport
// directly.
export function recordEventLoopStall(
  section: StallSection,
  durationMs: number,
  thresholdMs: number,
  lookbackMs: number,
): void {
  const { culpritStack, hotFrame } = deriveCulprit(section);

  // Coverage test at the trip instant (synchronous, alongside captureTrace).
  // `captureFlightWindow` reads the module-level open-entry registry + completed
  // ring directly (no ALS), so it is safe to call from here. Was ANY tracked
  // ENTRY span in flight across the freeze? No ⇒ the CPU burst inflated nothing
  // the profiler can see ⇒ we badge the report as the profiler-invisible culprit.
  // The window looks back `lookbackMs` on the profiler's own clock domain: to
  // where the block began when the sampler placed it, else to the previous drain.
  const fw = captureFlightWindow({
    windowStartMs: profilerNowMs() - lookbackMs,
  });
  const cov = classifyCoverage(fw, durationMs);

  // Evidence first — captureTrace mints the id synchronously (before persist) and
  // never throws. Pass the STABLE `culpritStack` as the label: `label` is part of
  // the engine's kind:label admission/cooldown key, so a varying per-tick label
  // would defeat trace-side dedup across the ticks of one sustained freeze.
  const trace = captureTrace({
    kind: "stall",
    label: culpritStack,
    durationMs,
    thresholdMs,
    critical: true,
    detail: section,
  });

  // Plain `void` — recordReport already wraps its own DB/bell writes in
  // runInBackgroundLane(runWithoutProfiling(…)) internally, so the caller must NOT
  // double-wrap (precedent: reports' server-error handler does `void recordReport(…)`
  // from a sync callback). Satisfies no-floating-promises; no catch (no-bare-catch).
  void recordReport({
    kind: "event-loop-stall",
    source: "server-stall-monitor",
    data: {
      durationMs,
      thresholdMs,
      nSamples: section.nSamples,
      sampleRateHz: section.sampleRateHz,
      ...(section.scope ? { scope: section.scope } : {}),
      ...(section.spanMs !== undefined ? { spanMs: section.spanMs } : {}),
      ...(section.windowSampleRateHz !== undefined
        ? { windowSampleRateHz: section.windowSampleRateHz }
        : {}),
      culpritStack,
      hotFrame,
      topLeaves: section.topLeaves,
      topStacks: section.topStacks,
      ...(trace ? { traceId: trace.id } : {}),
      unspanned: cov.unspanned,
      ...(cov.unspanned ? {} : { coveringSpan: cov.coveringSpan }),
    },
    message: `Event-loop stall ${Math.round(durationMs)}ms — ${hotFrame}`,
  });
}

// The evidence side of a SHORT stall (0.5 s up to the report threshold): the
// stacks the sampler took during ONE registered block, as a `stall` trace in
// Debug → Slow Events — no report. Main stalled like this in 5–10% of its 10 s
// windows (2026-11-05), too often for each to be an alert, and until this seam
// none of them carried a stack: a block that is not a freeze still delays every
// query and push in flight behind it. Non-critical, so the trace engine's
// cooldown, per-minute ceiling and duress shedding all apply; labelled with the
// dominant caller stack like the freeze trace, so one recurring culprit is one
// trigger and its traces group by label. The label is prefixed: the engine's
// cooldown key is kind:label, so sharing the freeze trace's label would let a
// short stall's trace cool down the critical trace of a freeze of the same
// culprit right after it — and its report would lose the evidence link.
export function recordLoopStallEvidence(
  section: StallSection,
  durationMs: number,
  thresholdMs: number,
): void {
  const { culpritStack } = deriveCulprit(section);
  captureTrace({
    kind: "stall",
    label: `short stall: ${culpritStack}`,
    durationMs,
    thresholdMs,
    detail: section,
  });
}
