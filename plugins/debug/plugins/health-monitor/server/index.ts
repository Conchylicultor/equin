import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { healthSeriesServed } from "./internal/health-series";
import {
  processSamplerTimer,
  startProcessSampler,
  stopProcessSampler,
} from "./internal/process-sampler";
import {
  hostSamplerTimer,
  startHostSampler,
  stopHostSampler,
} from "./internal/host-sampler";

// Every sample as it is taken, for plugins that build on the health series
// without tailing its JSONL (debug/latency-ledger).
export { onHealthSample } from "./internal/process-sampler";
export type { HealthSampleObserver } from "./internal/process-sampler";
export { onStackSamples } from "./internal/stall-profiler";
export type { StackSampleObserver } from "./internal/stall-profiler";
export { onHostSample } from "./internal/host-sampler";
export type { HostSampleObserver } from "./internal/host-sampler";

// The health JSONL line shapes, for server-side consumers that scan the same
// per-worktree files this plugin writes (debug/timeline's health heat lanes).
export { HealthSampleSchema, HostSampleSchema } from "../core";
export type { HealthSample, HostSample } from "../core";

export default {
  description:
    "Continuous per-backend health sampler: event-loop lag, GC/heap pressure, and phys_footprint appended to per-worktree JSONL (read from disk even when a backend is wedged), plus main-only host metrics. Surfaced as the Debug → Health pane.",
  contributions: [...healthSeriesServed.declare],
  register: [processSamplerTimer, hostSamplerTimer],
  onReady: () => {
    startProcessSampler();
    if (isMain()) startHostSampler();
  },
  onShutdown: () => {
    stopProcessSampler();
    if (isMain()) stopHostSampler();
  },
} satisfies ServerPluginDefinition;
