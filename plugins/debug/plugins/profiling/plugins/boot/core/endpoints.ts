import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { BootGatewaySchema } from "@plugins/debug/plugins/trace/plugins/boot/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";

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
  // CPU this process had used by then (user + system, ms); absent on a host
  // with no CPU reader.
  cpuMs: z.number().optional(),
});
export type MemoryCheckpoint = z.infer<typeof MemoryCheckpointSchema>;

export const ProfilingDataSchema = z.object({
  spans: wholeList(SpanSchema, {
    reason:
      "one process boot's spans — one per boot phase, plugin step and warm-up, a few hundred, fixed once the warm-ups drain",
  }),
  totalMs: z.number(),
  memoryCheckpoints: wholeList(MemoryCheckpointSchema, {
    reason: "one per boot phase boundary — a dozen or so",
  }),
  // Epoch ms of process start (performance.timeOrigin) — the wall anchor that
  // places this process on another clock's timeline (the cold-start
  // benchmark's).
  processStartedAt: z.number(),
  // Span / checkpoint offsets are from the profiler's boot start, this many ms
  // after process start (the imports before the profiler module evaluates):
  // an offset's epoch ms is processStartedAt + bootStartOffsetMs + offset.
  bootStartOffsetMs: z.number(),
  // CPU this process has used up to this read (user + system, ms) — with the
  // checkpoints' cpuMs, what the boot and the work after it cost
  // (the restart-storm benchmark reads it once the tabs settled). Absent on a
  // host with no CPU reader.
  cpuMsNow: z.number().optional(),
  // The gateway's spawn/readiness stamps for this process (boot-monitor's
  // gateway report), absent when the gateway has not POSTed one.
  gateway: BootGatewaySchema.optional(),
});
export type ProfilingData = z.infer<typeof ProfilingDataSchema>;

export const getBootProfiling = defineEndpoint({
  route: "GET /api/debug/profiling/boot",
  response: ProfilingDataSchema,
});
