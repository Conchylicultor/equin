import { liveValue } from "@plugins/network/plugins/live/core";
import { ProfilingDataSchema } from "./endpoints";

/**
 * This process's boot profile: the profiler's spans and phase-boundary memory
 * checkpoints, plus the gateway's readiness stamps.
 *
 * A snapshot — read when the Profiling pane mounts and again on its Refresh.
 * The profile keeps growing after the backend starts serving (the onReady /
 * onAllReady spans, every warm-up, the closing `drainWarmups` span and its
 * checkpoint, and the gateway's report ~100 ms after the proxy swap), and
 * neither the profiler nor the gateway report publishes a change signal, so no
 * push form of it could be honest.
 */
export const bootProfiling = liveValue("profiling.boot", {
  schema: ProfilingDataSchema,
  load: "snapshot",
});
