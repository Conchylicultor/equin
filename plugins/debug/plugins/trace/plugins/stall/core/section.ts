import { z } from "zod";

// The stall event class's snapshot section (persisted under
// snapshot.events.stall). It is the aggregate of the JSC sampling profiler's
// drained stacks over an event-loop freeze — NOT time-positioned bars, so the
// web lane renders it as a histogram card (the gates/contention shape).
//
// The freeze duration and wall time are intentionally NOT duplicated here: they
// are already `trigger.durationMs` (= eventLoopMaxMs) and the trace `wallTime`.
// This section is purely the stack evidence.
//
// This is the single source of truth for the section shape, shared by:
//   - the health-monitor sampler that builds it (from aggregateTraces),
//   - the server class that validates it,
//   - the web lane that parses it.

// One innermost-frame ("leaf") identity and how often samples sat there. `key`
// is `name @ path:line` for JS frames, `name [category]` for native frames.
export const StallLeafSchema = z.object({
  key: z.string(),
  count: z.number(),
  pct: z.number(),
});
export type StallLeaf = z.infer<typeof StallLeafSchema>;

// One collapsed, name-only call-path signature (innermost → outermost, `←`
// joined) and its sample frequency.
//
// `frames` carries the SAME frames resolved to full `frameKey` identities (the
// `name @ path:line` / `name [category]` form used by `StallLeaf.key`), in the
// same order. Invariant, enforced by construction in `aggregateTraces` and
// asserted in its tests:
//
//   frames[i] is the frameKey of the frame whose bare name is
//   stack.split(" ← ")[i]   — same slice, same order, same 40-frame cap.
//
// So `frames[0]` is always this stack's own leaf key.
//
// They are ONE representative sample's keys, not a canonical position for the
// path — `frame.line` is the sample's executing line, so traces sharing a
// name-only signature can resolve differently. Read `frames` as *a* position on
// the call path, not *the* position: enough to attribute it to a subsystem.
//
// Why both: `stack` stays name-only because it is the report's dedup grain —
// line-free and robust to edits. But a name-only signature cannot be attributed
// to a source location, and the two independent histograms (`topLeaves` vs
// `topStacks`) could never be cross-referenced: a label drawn from `topLeaves`
// may describe a DIFFERENT stall than the one `topStacks[0]` fingerprints. That
// really happened — a `spawn`-rooted freeze (46.7 % of samples) was titled with a
// 1-sample drizzle frame. `frames` restores the leaf↔stack association the
// aggregator used to discard, so a consumer can attribute the dominant stack
// using only that stack's own evidence.
//
// Optional: traces persisted before this field existed still parse.
export const StallStackSchema = z.object({
  stack: z.string(),
  count: z.number(),
  pct: z.number(),
  frames: z.array(z.string()).optional(),
});
export type StallStack = z.infer<typeof StallStackSchema>;

// What span of time the samples were selected from.
//
// - `block` — only the registered block's: from one loop-probe period before
//   the late probe tick was due (where the block began at the earliest) to the
//   tick that ended it. Every sample is the blocked thread's.
// - `window` — the sampler's whole drain window (~10 s), because no block the
//   loop probe registered could be placed in it. Ordinary work around the block
//   is mixed in, so a stack here is NOT shown to have blocked the thread.
//
// Optional: traces persisted before this field existed were all `window` for a
// freeze and `block` for a short stall.
export const StallScopeSchema = z.enum(["block", "window"]);
export type StallScope = z.infer<typeof StallScopeSchema>;

export const StallSectionSchema = z.object({
  // JSC stack samples taken during `spanMs` (0 for a block is a finding: the
  // thread ran no JS while it was blocked — descheduled, faulting pages in, or
  // in native work outside the VM — so no stack of this process blocked it).
  nSamples: z.number(),
  // nSamples over the span they were selected from, never assumed.
  sampleRateHz: z.number(),
  scope: StallScopeSchema.optional(),
  // How long the selection span was (ms).
  spanMs: z.number().optional(),
  // The sampler's rate over the whole drain window around it — the rate the
  // thread was sampled at while it ran JS. A block sampled far below it spent
  // most of its time off the CPU or outside JS.
  windowSampleRateHz: z.number().optional(),
  topLeaves: z.array(StallLeafSchema),
  topStacks: z.array(StallStackSchema),
});
export type StallSection = z.infer<typeof StallSectionSchema>;
