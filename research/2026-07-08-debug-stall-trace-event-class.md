# Stall stacks → the unified trace system: a `stall` trigger + event class

**Date:** 2026-07-08 · **Category:** debug (health-monitor, trace, +tiny engine change)

## Context

The health-monitor stall-profiler is the **last persisted perf signal outside the
unified trace system**. It runs a JSC sampling profiler on a background thread
(so it keeps sampling the blocked main-thread stack *during* a synchronous
freeze), drains it every 10 s health tick, and — when a tick's
`eventLoopMaxMs > 3 s` (a frozen backend, the most severe incident class) —
aggregates the samples into a `topLeaves`/`topStacks` histogram and appends a
line to `logs/stall-profiles.jsonl`.

That file has **zero readers**: no pane, no report, no trace linkage
(`stall-profiler.ts:211` `channel.publish(...)` is the only write; a repo-wide
grep finds no consumer). The Health pane shows *that* a stall happened (the
`eventLoopMaxMs` spike line) but never *what code* caused it — the one artifact
that answers that question is dumped to a dead-end JSONL. The unified-tracing
research doc (`research/2026-07-08-global-unified-slow-event-tracing.md` §2)
already flagged this as out-of-scope-but-natural to migrate, and the trace
engine's own `CLAUDE.md` calls out the same anti-pattern it replaced ("the old
flight-recorder dumped this to dead-end JSONL").

**Outcome:** a >3 s freeze becomes a first-class **Slow Event** — its own row in
Debug → Slow Events (a huge `×N` over-budget) whose trace detail carries a
stall-stacks lane (the `topLeaves`/`topStacks` histogram), sitting beside the
ambient `spans`/`gates`/`contention` lanes at the recovery instant. The
`stall-profiles.jsonl` sink is deleted.

## Design decision: stall is a **trigger**, not an ambient ring lane

The research doc floated stall stacks as a "future ring-class migration" — an
ambient lane that appears on *other* triggers' traces. That fits poorly and we
reject it:

- The drain is **coarse** (one aggregate per 10 s tick), and the JSC samples
  carry no usable per-sample profiler-clock timestamp — so the engine's
  fine-grained `ring.slice([windowStartMs, atMs])` can't align them to a trip
  window.
- **During a freeze the blocked main thread cannot call `captureTrace` at all**,
  so a slow-span trace can never be captured *inside* a stall — an ambient stall
  lane would have almost nothing to attach to.

A stall is honestly its own slow event: *"the event loop froze for 41 s; here is
the sampled stack evidence."* So the health sampler, on detecting a stall, calls
`captureTrace({ kind: "stall", … })`, and a thin new `stall` event class surfaces
the stacks. This is exactly the op-rate/op-time precedent (a monitor detects a
condition and mints a trigger) — **zero engine edits to the registry**.

## Change set

### 1. New sub-plugin `plugins/debug/plugins/trace/plugins/stall/`

Sibling of `spans`/`gates`/`contention`, mirroring their three-file shape
byte-for-byte (`contention` is the closest model — a schema + a single hook + a
card lane).

**`core/index.ts`** — the section contract, shared by the health sampler (builds
it), the server class (validates it), and the web lane (parses it). Reuses the
`fields/*` zod idiom or a plain `z.object`:

```ts
export const StallLeafSchema  = z.object({ key: z.string(),   count: z.number(), pct: z.number() });
export const StallStackSchema = z.object({ stack: z.string(), count: z.number(), pct: z.number() });
export const StallSectionSchema = z.object({
  nSamples: z.number(),
  sampleRateHz: z.number(),
  topLeaves: z.array(StallLeafSchema),
  topStacks: z.array(StallStackSchema),
});
export type StallSection = z.infer<typeof StallSectionSchema>;
```

> `eventLoopMaxMs` and `sampledAt` are **not** duplicated into the section — they
> are already `trigger.durationMs` and the trace `wallTime`. The section is
> purely the stack evidence.

**`server/internal/class.ts`** — the registry contribution. The `stall` class is
**trigger-owned**: its data is pre-aggregated by the sampler (raw JSC traces are
far too large to pass through a trigger) and handed in via `trigger.detail`, so
`captureAtTrip` is a cheap synchronous passthrough gated on the kind. Returning
`undefined` for every non-stall trip means a slow-span trace gets no empty
`stall` section (the engine's documented skip path):

```ts
export const stallClass = defineTraceEventClass({
  id: "stall",
  schema: StallSectionSchema,
  // Trigger-owned: the sampler already aggregated the stacks (raw JSC traces
  // are too large to carry). Passthrough of the pre-built section; the engine
  // schema-validates it under snapshot.events.stall.
  captureAtTrip: (ctx) =>
    ctx.trigger.kind === "stall" ? (ctx.trigger.detail as StallSection) : undefined,
});
```

**`server/index.ts`** — `contributions: [stallClass.contribution]`.

**`web/index.ts`** — `Trace.Lane({ match: "stall", component: StallLane })` plus
an optional `Trace.TriggerSummary({ match: "stall", component: StallSummary })`
(keeps stall-specific presentation in the stall plugin; falls back to
`GenericTriggerSummary` otherwise).

**`web/components/stall-lane.tsx`** — a **card lane** (the `contention`/`gates`
shape, not Gantt bars — the histogram is a point-in-time aggregate over the whole
freeze window): a header line (freeze duration from `trace.trigger.durationMs`,
`nSamples`, `sampleRateHz`), then `topLeaves` as a ranked list with pct bars, and
`topStacks` as expandable name-only call-path signatures. `onSelect` may report a
clicked stack to the shared detail strip (`{ title, fields }`). `safeParse` the
payload with `StallSectionSchema` and render a muted placeholder on miss — the
`ContentionLane` pattern.

**`CLAUDE.md`** — prose + autogen block (build regenerates the reference).

### 2. Health-monitor: swap the JSONL sink for `captureTrace`

**`plugins/debug/plugins/health-monitor/server/internal/stall-profiler.ts`** —
keep the profiler lifecycle, the per-tick drain (still required to bound the JSC
buffer), and the pure `aggregateTraces`/`frameKey`/`topN`/`shortenSource`
helpers + `stall-profiler.test.ts`. Replace the sink:

- **Delete** the JSONL path: `Log`/`LogChannel` import, `channel`, `stallFilePath`,
  `rotateIfNeeded`, `MAX_FILE_BYTES`, and the now-unused `node:fs` / `node:path` /
  `worktreeDataDir` / `currentWorktreeName` imports.
- **Import** `captureTrace` from `@plugins/debug/plugins/trace/plugins/engine/server`
  and `StallSection`/`StallSectionSchema` from
  `@plugins/debug/plugins/trace/plugins/stall/core`.
- `startStallProfiler` / `stopStallProfiler` drop all `channel` handling (just
  `startSamplingProfiler()` + `armed`).
- `drainAndMaybeDump` (unchanged detection/drain), on a confirmed stall:

```ts
const { topLeaves, topStacks } = aggregateTraces(traces);
const section: StallSection = { nSamples: traces.length, sampleRateHz, topLeaves, topStacks };
captureTrace({
  kind: "stall",
  label: topLeaves[0]?.key ?? "event-loop stall",
  durationMs: eventLoopMaxMs,          // the freeze duration → ×N over 3 s in the list
  thresholdMs: STALL_THRESHOLD_MS,     // 3000
  critical: true,                      // see §3 — never starved by a span storm
  detail: section,
});
```

The trace's ambient `spans`/`gates`/`contention` classes still run at the
recovery instant (honest context — was the host saturated during the freeze?);
the `stall` lane, covering the whole freeze window, is the star.

Import direction stays a DAG: `health-monitor → trace/engine` + `trace/stall/core`;
`trace/stall → trace/engine`; nothing in `trace/` imports health-monitor.

### 3. Engine: a `critical` trigger flag that skips the per-minute cap

A frozen backend is the most severe signal and must never be dropped by a
post-freeze burst of slow spans exhausting the shared `maxPerMin` budget in the
same minute. Add a minimal, generic opt-out (keeps the per-trigger cooldown, so
recurring identical freezes still dedupe):

- **`trace/plugins/engine/core/types.ts`** — `TraceTriggerSchema` gains
  `critical: z.boolean().optional()`.
- **`trace/plugins/engine/server/internal/rate-limit.ts`** — `admitTrace` gains a
  trailing `critical = false` param; skip the `minuteCount >= maxPerMin` gate when
  `critical` (cooldown check unchanged). Update `rate-limit.test.ts` with a
  cap-exempt-but-cooldown-honored case.
- **`trace/plugins/engine/server/internal/capture.ts`** — pass
  `trigger.critical ?? false` to `admitTrace` (line 33).

This generalizes to any future critical trigger (e.g. a GC-pause detector) and is
the structural fix for the doc's documented shared-admission starvation risk.

### 4. Pane: colour the `stall` trigger badge

**`plugins/debug/plugins/trace/plugins/pane/web/internal/trigger-meta.ts`** — add
`stall: "destructive"` to `KIND_VARIANT` so a frozen backend reads red in the
Slow Events list. This is the sanctioned display-metadata home for trigger kinds
(an open vocabulary with a muted fallback) — not a collection-consumer violation
(trigger kinds ≠ event classes).

### 5. Docs

- `health-monitor/CLAUDE.md` — note stall stacks now flow to the trace store, not
  JSONL.
- `trace/CLAUDE.md` + `engine/CLAUDE.md` — mention `stall` alongside
  `spans`/`gates`/`contention` (the "adding a class" section already generalizes).
- `.claude/skills/debug/SKILL.md` — if it references `stall-profiles.jsonl`, point
  it at Debug → Slow Events instead.
- `docs/plugins-*.md` regenerate on `./equin build`.

## Critical files

| File | Change |
|---|---|
| `trace/plugins/stall/{package.json,core/index.ts,server/index.ts,server/internal/class.ts,web/index.ts,web/components/stall-lane.tsx,CLAUDE.md}` | **new** event-class sub-plugin |
| `health-monitor/server/internal/stall-profiler.ts` | JSONL sink → `captureTrace({kind:"stall",critical:true,detail})` |
| `trace/plugins/engine/core/types.ts` | `TraceTriggerSchema.critical?` |
| `trace/plugins/engine/server/internal/rate-limit.ts` (+`.test.ts`) | `admitTrace(..., critical)` skips cap |
| `trace/plugins/engine/server/internal/capture.ts` | pass `trigger.critical` |
| `trace/plugins/pane/web/internal/trigger-meta.ts` | `stall: "destructive"` |

## Verification

1. **`./equin build`** — green (registry regenerates the new sub-plugin;
   migration unaffected — no schema change).
2. **`./equin check`** — boundaries (DAG intact), `plugins-doc-in-sync`,
   `type-check`.
3. **Unit:** `bun test plugins/debug/plugins/trace/plugins/engine/server/internal/rate-limit.test.ts`
   (critical bypasses cap, still honors cooldown); the existing
   `stall-profiler.test.ts` (`aggregateTraces`) stays green.
4. **End-to-end stall capture** (the real path — no JSONL to inspect anymore):
   trigger a synthetic freeze on **main** (a throwaway server route or one-off
   that busy-loops ~4 s on the main thread), wait for the next 10 s health tick,
   then:
   - `query_db` (main): `SELECT trigger_kind, jsonb_object_keys(snapshot->'events') FROM traces WHERE trigger_kind='stall'` → expect a row with `stall` (plus `spans`/`gates`/`contention`).
   - `bun e2e/screenshot.mjs --url http://<wt>.localhost:9000/debug/traces` → the `stall` row (red badge, large `×N`); click it → the stall-stacks lane renders `topLeaves`/`topStacks` in the detail Gantt.
5. Confirm the sink is gone: `rg stall-profiles plugins/` → only research docs.
