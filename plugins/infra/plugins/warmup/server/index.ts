import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { drainWarmups } from "./internal/executor";

export { defineWarmup, listRegisteredWarmups } from "./internal/registry";
export type { RegisteredWarmup, WarmupSpec } from "./internal/registry";
export { WARMUP_CONCURRENCY } from "./internal/executor";
export type { WarmupRun } from "./internal/executor";
export { onWarmupRun, warmupRunOf } from "./internal/runs";
export { WarmupHost } from "./internal/host";
export type { WarmupHostImpl } from "./internal/host";

export default {
  description:
    "Declared heavy boot warm-up category, on every host: defineWarmup registers a deferred, throttled, scope-gated warm-up; the plugin's onSettled drains them once the serving host has settled (never in exec) under a concurrency gate + the host's admission (the WarmupHost host service: which scopes run here, and the slot each takes) + macrotask yield, recording each warm-up's run in memory (warmupRunOf / onWarmupRun); listRegisteredWarmups lists the declared set with the plugin that declared each.",
  portable: true,
  onSettled: drainWarmups,
} satisfies ServerPluginDefinition;
