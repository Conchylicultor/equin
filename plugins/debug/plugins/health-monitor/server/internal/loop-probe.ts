import { noteLoopTurn } from "@plugins/infra/plugins/runtime-profiler/core";
import { defineTimer } from "@plugins/infra/plugins/background/plugins/timer/server";
import { noteRegisteredStall } from "./stall-profiler";

// The event-loop probe: a tick due every PROBE_PERIOD_MS whose lateness is a
// stall of this process's loop. The runtime profiler charges a registered stall
// to every database call it overlapped as an `event-loop` wait, so a query is
// judged on its own time rather than on the time the thread was blocked
// (runtime-profiler's "Event-loop stalls"). The 10 s process sampler measures
// how BAD the lag was; this says WHEN, to the 100 ms — and so which stack
// samples were the block's (`noteRegisteredStall`: a 0.5–3 s block's own stacks
// as a `stall` trace, where the 10 s window's would drown it in ordinary work).
//
// A stall shorter than PROBE_TOLERANCE_MS past the period is timer jitter, not
// a stall worth charging: every slow-op bar sits at 500 ms or more.
const PROBE_PERIOD_MS = 100;
const PROBE_TOLERANCE_MS = 100;

export const loopProbeTimer = defineTimer({
  name: "health.loop-probe",
  description:
    "Notes each turn of this backend's event loop every 100 ms, so a database call that finished while the loop was blocked is charged the block as an event-loop wait instead of as its own time, and a 0.5–3 s block is traced with the stacks sampled during it.",
  everyMs: PROBE_PERIOD_MS,
  profile: "invisible",
  run: () => {
    const stall = noteLoopTurn(PROBE_PERIOD_MS, PROBE_TOLERANCE_MS);
    if (stall) noteRegisteredStall(stall, PROBE_PERIOD_MS);
  },
});
