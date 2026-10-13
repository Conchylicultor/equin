import { getProfilingData } from "@plugins/framework/plugins/server-core/core";
import { getGatewayBootReport } from "@plugins/debug/plugins/boot-monitor/server";
import type { ProfilingData } from "../../core";

/** This process's boot profile, as the profiling pane and the cold-start e2e read it. */
export function readBootProfile(): ProfilingData {
  const server = getProfilingData();
  const gateway = getGatewayBootReport();
  return {
    spans: server.spans,
    totalMs: server.totalDurationMs,
    memoryCheckpoints: server.memoryCheckpoints,
    processStartedAt: performance.timeOrigin,
    bootStartOffsetMs: server.bootStartOffsetMs,
    ...(gateway ? { gateway } : {}),
  };
}
