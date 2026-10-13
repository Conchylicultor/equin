import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// One boot-snapshot key's accounting: where the value came from and the work it
// cost. `memory` is a persisted alias's kept in-memory snapshot (warm mode only —
// cold mode bypasses it); `persisted` workMs is the single batched read amortized
// ÷ N (directional, not per-key truth); `loader` workMs is the real from-scratch
// load.
const perKeySchema = z.object({
  source: z.enum(["memory", "persisted", "loader"]),
  workMs: z.number(),
});

// One first-subscribe cycle's latency, or null when its fixture id was missing
// (the target was skipped, not measured).
const firstSubscribeSchema = z
  .object({
    onFirstSubscribeMs: z.number(),
    loaderMs: z.number(),
  })
  .nullable();

// One runtime-profiler aggregate (loader or db), with its per-call wall-clock
// decomposition. `waits` is the per-call amortized wait by gate/lock layer (e.g.
// `heavy-read-acquire`; each an interval union ≤ wall); `selfMs` is the entry's
// own work (wall − union(waits ∪ direct children)) and `childMs` the direct-child
// union — a high `avgMs` with a high wait / low `selfMs` is head-of-line
// blocking, not a slow op. Values are rounded at the edge.
const profileEntrySchema = z.object({
  label: z.string(),
  count: z.number(),
  avgMs: z.number(),
  selfMs: z.number(),
  childMs: z.number(),
  maxMs: z.number(),
  waits: z.record(z.string(), z.number()).optional(),
});

// Physical bloat of the `live_state_snapshot` table — the persisted-read cost only
// reproduces against real dead-tuple bloat (warm mode against main).
const bloatSchema = z.object({
  tableBytes: z.number(),
  deadTuples: z.number(),
  liveTuples: z.number(),
});

// The boot snapshot's size, as the endpoint serializes it: raw UTF-8 bytes and
// gzip (level 6, what `gzip -6` and the usual HTTP compressor give).
const byteSizeSchema = z.object({ raw: z.number(), gzip: z.number() });

// Measured once per mode, outside the timed burst. `total` is the whole body,
// `perKey` each key's own value, and `rowKeyBytes` — for each key whose rows
// carry the server-minted row key (`$key`) — the mean bytes that member adds to
// one row (times a deployment's row count: what the row key costs that key
// there). A key none of whose rows carries one is absent from `rowKeyBytes`.
const snapshotBytesSchema = z.object({
  total: byteSizeSchema,
  perKey: z.record(z.string(), byteSizeSchema),
  rowKeyBytes: z.record(z.string(), z.number()),
});
export type SnapshotBytes = z.infer<typeof snapshotBytesSchema>;

// One full benchmark iteration measured in the target backend's own process.
export const iterResultSchema = z.object({
  bootSnapshot: z.object({
    totalMs: z.number(),
    perKey: z.record(z.string(), perKeySchema),
    // Wall time of the single batched persisted-snapshot read (the L2 fast path).
    persistedReadMs: z.number(),
  }),
  firstSubscribe: z.record(z.string(), firstSubscribeSchema),
  eventLoop: z.object({
    maxMs: z.number(),
    p99Ms: z.number(),
    meanMs: z.number(),
  }),
  runtimeProfile: z.object({
    loaders: z.array(profileEntrySchema),
    db: z.array(profileEntrySchema),
  }),
  // Present only when this iteration ran under a host-gate load (loadConcurrency>0).
  // `peakGateWaitMs` is the burst's own peak per-call heavy-read wait (acquire +
  // local) across its loader entries — measured in-process, not the host queue gauge.
  load: z
    .object({
      concurrency: z.number(),
      peakGateWaitMs: z.number().optional(),
    })
    .optional(),
});
export type IterResult = z.infer<typeof iterResultSchema>;

export const bootBenchRunResponseSchema = z.object({
  fixtures: z.object({
    conversationId: z.string().nullable(),
    attemptId: z.string().nullable(),
  }),
  runs: z.object({
    cold: z.array(iterResultSchema).optional(),
    warm: z.array(iterResultSchema).optional(),
  }),
  // Captured ONCE per mode at the start of its set (before any cold-clear delete,
  // which churns the very table being measured). Bloat only reproduces in warm
  // mode against an already-bloated DB (main).
  snapshotBloat: z
    .object({
      cold: bloatSchema.optional(),
      warm: bloatSchema.optional(),
    })
    .optional(),
  // The boot snapshot's bytes, captured ONCE per mode beside its bloat (before
  // the set's timed iterations), so the extra assemble never lands in a burst.
  snapshotBytes: z
    .object({
      cold: snapshotBytesSchema.optional(),
      warm: snapshotBytesSchema.optional(),
    })
    .optional(),
});
export type BootBenchRunResponse = z.infer<typeof bootBenchRunResponseSchema>;

export const bootBenchRunBodySchema = z.object({
  iterations: z.number().int().positive().optional(),
  warmup: z.number().int().nonnegative().optional(),
  mode: z.enum(["cold", "warm", "both"]).optional(),
  conversationId: z.string().optional(),
  attemptId: z.string().optional(),
  // Occupants to hold on the host-wide `heavy-read` gate during the burst.
  // 0 (default) = current isolated behavior.
  loadConcurrency: z.number().int().nonnegative().optional(),
});
export type BootBenchRunBody = z.infer<typeof bootBenchRunBodySchema>;

export const bootBenchRun = defineEndpoint({
  route: "POST /api/debug/boot-bench/run",
  body: bootBenchRunBodySchema,
  response: bootBenchRunResponseSchema,
});
