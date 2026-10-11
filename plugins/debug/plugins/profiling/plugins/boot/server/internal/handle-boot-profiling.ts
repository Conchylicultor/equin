import { getProfilingData } from "@plugins/framework/plugins/server-core/core";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { getGatewayBootReport } from "@plugins/debug/plugins/boot-monitor/server";
import { getBootProfiling } from "../../core";

export const handleBootProfiling = implement(getBootProfiling, () => {
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
});
