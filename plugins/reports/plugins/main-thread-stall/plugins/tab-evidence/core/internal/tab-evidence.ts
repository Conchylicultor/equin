import { z } from "zod";

// One aggregated main-thread JS stack the sampling profiler caught inside the
// window: frames innermost first, each `name (url:line:col)`; `ms` is the
// sampled time spent in exactly this stack.
export const StallStackSchema = z.object({
  ms: z.number(),
  samples: z.number(),
  frames: z.array(z.string()),
});
export type StallStack = z.infer<typeof StallStackSchema>;

// What ran underneath a long frame's entry point, from the tab's rolling JS
// Self-Profiling trace (main-thread-stall's web/internal/stall-profiler.ts).
// `sampled` only for a window the tab itself lived through and filed (a stall
// it survived, a slow interaction, a long frame); otherwise `unavailable`
// with the reason — never an empty `sampled`, which would read as "no JS ran".
export const StallStacksSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sampled"),
    // The profiler's requested and the trace's actual mean sample interval.
    sampleIntervalMs: z.number(),
    // Sampled time inside the stall window, and how much of it ran no JS
    // (no stack: style, layout, paint, GC — or the thread not scheduled).
    sampledMs: z.number(),
    noJsMs: z.number(),
    // The profiler's buffer filled before the stall ended: the stacks cover
    // its first `sampledMs` only.
    truncated: z.boolean(),
    // The heaviest exact stacks, heaviest first (capped).
    stacks: z.array(StallStackSchema),
    // The heaviest innermost frames (self time across every stack), capped.
    topSelf: z.array(z.object({ frame: z.string(), ms: z.number() })),
  }),
  z.object({ kind: z.literal("unavailable"), reason: z.string() }),
]);
export type StallStacks = z.infer<typeof StallStacksSchema>;

// The tab's JS heap around a freeze (main-thread-stall's web/internal/heap-watch.ts):
// in use at its last reading before the stall began (`beforeAgoMs` earlier;
// null when it had none) and right after it, against the heap's ceiling. It
// tells apart what sampled stacks with no JS cannot: V8 collecting garbage
// near its limit (high before, near `limitMb`, lower after), a process starved
// of CPU, or JS the profiler may not show. `measured` only for a stall the
// stalled tab survived and filed; otherwise `unavailable` with the reason.
export const StallMemorySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("measured"),
    beforeMb: z.number().nullable(),
    beforeAgoMs: z.number().nullable(),
    afterMb: z.number(),
    limitMb: z.number(),
  }),
  z.object({ kind: z.literal("unavailable"), reason: z.string() }),
]);
export type StallMemory = z.infer<typeof StallMemorySchema>;

// What a tab files about a window its own thread ran (a stall it survived, a
// slow interaction, a long frame): the stacks it sampled and the heap around
// it. Evidence only — never part of a report's fingerprint or summary.
export const TabEvidenceSchema = z.object({
  stacks: StallStacksSchema,
  memory: StallMemorySchema,
});
export type TabEvidence = z.infer<typeof TabEvidenceSchema>;
