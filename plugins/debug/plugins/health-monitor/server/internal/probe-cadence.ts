// The event-loop probe's cadence (loop-probe.ts), shared with the stall
// profiler, which places a block among the probe's registered stalls: a tick
// due every PROBE_PERIOD_MS, so a registered stall `[due, end]` began at most
// one period before `due`.
//
// A tick late by no more than PROBE_TOLERANCE_MS is timer jitter, not a stall
// worth charging: every slow-op bar sits at 500 ms or more.
export const PROBE_PERIOD_MS = 100;
export const PROBE_TOLERANCE_MS = 100;
