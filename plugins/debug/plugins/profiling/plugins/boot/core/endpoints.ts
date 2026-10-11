import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { BootGatewaySchema } from "@plugins/debug/plugins/trace/plugins/boot/core";

const SpanSchema = z.object({
  id: z.string(),
  phase: z.string(),
  plugin: z.string().optional(),
  label: z.string(),
  startMs: z.number(),
  durationMs: z.number(),
  physFootprintStartMb: z.number().optional(),
  physFootprintEndMb: z.number().optional(),
});

// Phase-boundary memory snapshot — the authoritative per-phase footprint numbers
// (mirrors the profiler's MemoryCheckpoint).
const MemoryCheckpointSchema = z.object({
  label: z.string(),
  atMs: z.number(),
  physFootprintMb: z.number(),
  heapUsedMb: z.number(),
  externalMb: z.number(),
  arrayBuffersMb: z.number(),
});
export type MemoryCheckpoint = z.infer<typeof MemoryCheckpointSchema>;

export const ProfilingDataSchema = z.object({
  spans: z.array(SpanSchema),
  totalMs: z.number(),
  memoryCheckpoints: z.array(MemoryCheckpointSchema),
  // Epoch ms of process start (performance.timeOrigin) — the wall anchor that
  // places this process on another clock's timeline (the cold-start
  // benchmark's).
  processStartedAt: z.number(),
  // Span / checkpoint offsets are from the profiler's boot start, this many ms
  // after process start (the imports before the profiler module evaluates):
  // an offset's epoch ms is processStartedAt + bootStartOffsetMs + offset.
  bootStartOffsetMs: z.number(),
  // The gateway's spawn/readiness stamps for this process (boot-monitor's
  // gateway report), absent when the gateway has not POSTed one.
  gateway: BootGatewaySchema.optional(),
});
export type ProfilingData = z.infer<typeof ProfilingDataSchema>;

export const getBootProfiling = defineEndpoint({
  route: "GET /api/debug/profiling/boot",
  response: ProfilingDataSchema,
});
