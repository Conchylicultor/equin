import { monitorEventLoopDelay } from "node:perf_hooks";

// A dedicated, on-demand event-loop-delay probe for the boot benchmark window.
// A second native histogram alongside health-monitor's continuous sampler is
// safe — each `monitorEventLoopDelay` instance is an independent native sampler.
// It is finer (10ms resolution) and brackets a sub-second burst because the
// histogram accumulates in C even while JS is blocked, so a late tick is itself
// signal and the recorded `max` still reveals a stall.
//
// Lazily created + enabled on first reset so the native sampler only runs while a
// benchmark is in flight. Durations are nanoseconds → divide by 1e6 for ms.
// Named by what returns it: @types/node renamed the type (IntervalHistogram → ELDHistogram).
let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;

export function resetEldProbe(): void {
  if (!histogram) {
    histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
  }
  histogram.reset();
}

export function readEldProbe(): { maxMs: number; p99Ms: number; meanMs: number } {
  if (!histogram) {
    // resetEldProbe is always called before a measured window opens; reaching
    // here means a programming error in the orchestration, so fail loudly.
    throw new Error("readEldProbe called before resetEldProbe");
  }
  return {
    maxMs: histogram.max / 1e6,
    p99Ms: histogram.percentile(99) / 1e6,
    meanMs: histogram.mean / 1e6,
  };
}
