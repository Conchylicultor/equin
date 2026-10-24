# Per-instance span identity → the true call tree in the Slow Events Gantt

## Context

The runtime profiler identifies a span only by `{kind, label}`. A span's parent is a
**label snapshot** (`SpanRef`), not a pointer to a specific parent *run*. When two
instances of the same label run concurrently — the normal case for a `flush` draining
20 loaders, or two `http:/api/tasks` requests overlapping — nothing in the captured
`FlightWindow` says which child belongs to which parent instance.

Consequence, recorded as a known gap in
[`research/2026-07-08-global-unified-slow-event-tracing.md`](2026-07-08-global-unified-slow-event-tracing.md) §7:
the **Debug → Slow Events** trace Gantt cannot draw a nested waterfall. It falls back to
kind-grouped lanes (one row per `(kind,label)` bucket), and the blocking chain is a
*reading procedure* a human performs by eyeballing time overlap (documented in
`trace/plugins/engine/CLAUDE.md` "How to read a snapshot"). The evidence store contains
the tree; the wire format throws it away.

**The fix is small and structural**: the recorder already allocates one `EntryContext`
per entry span and already threads the live `parent: EntryContext` chain through
AsyncLocalStorage. Stamping a monotonic `id` on it — and carrying `id` / `parentId` on
`FlightSpan` instead of a `parents: SpanRef[]` label chain — makes the tree exact by
construction. One counter increment per span on the hot path; the snapshot gets
*smaller* (a depth-8 chain of objects per open span is replaced by two integers).

Intended outcome: the spans lane renders one row per **span instance**, depth-indented
under its true parent, ordered by `t0` — a real flamegraph/waterfall. The heuristic goes
away entirely.

Two adjacent findings surfaced during exploration and are fixed in the same change (both
are prerequisites for a *correct* tree, not scope creep):

1. **`cascade` enum drift — a live bug.** Both zod mirrors of `FlightSpan`
   (`spans/server/internal/class.ts:13,18` and `spans/web/internal/normalize.ts:11,15`)
   hardcode a 7-kind enum and omit `cascade`. Any `cascade` span in a captured window
   fails `FlightSpanSchema.safeParse` → the engine **omits the entire `spans` section**
   from the trace (loud only as a server error report). The `_assertFlightWindow`
   compile-time pin does not catch it: it only checks that `z.infer<Schema>` is
   *assignable to* `FlightWindow`, and a narrower `kind` union is assignable. The
   sibling file `debug/profiling/runtime/shared/endpoints.ts:12` already fixed exactly
   this failure and left a comment about it — the spans mirrors were missed.

2. **The tripping span is absent from its own trace.** In `recorder.ts` `record()`,
   `pushCompleted()` (the flight-ring write) runs **after** the `onSlowSpan` notify loop.
   The slow-span handler calls `captureTrace` synchronously, so at capture time the trip
   span is neither in `openEntries` (deleted in `recordEntrySpan`'s finally, before
   `record`) nor in the ring. Its children therefore render as orphan roots. Moving the
   ring write above the notify loop makes the trip span the actual **root** of the tree.

## Design

### 1. Recorder: mint a per-instance id (`plugins/infra/plugins/runtime-profiler/core/recorder.ts`)

```ts
// Monotonic, process-lifetime. NEVER reset: resetRuntimeProfile() leaves live
// EntryContexts alone (they deregister in their own finally), so a restarted
// counter would collide with in-flight ids.
let nextSpanId = 1;
```

- `EntryContext` gains `id: number`, minted in `recordEntrySpan` at open (before `fn`
  runs) so children can reference it while the parent is still in flight. The parent's id
  is `ctx.parent?.id ?? null` — no extra field; the live chain already exists.
- Leaf spans (`recordSpan`, and `chargeWait`'s context-less `db [layer]` fallback) mint
  their id at record time.
- Internal `record(...)` gains two positional params `spanId: number` and
  `parentId: number | null` (module-private; `SpanRef` stays `{kind,label}` — the
  aggregate `byParent` breakdown is per-*label* and must not grow an instance id).
- `SlowSpan` gains `id` / `parentId` (free — both are in scope at `record()`), so a
  trigger can name the exact span instance that tripped.
- `FlightRingSlot` gains `id` / `parentId` (preallocated slots; two more number writes,
  still zero allocation). `pushCompleted` takes them.
- **`FlightSpan`: `parents: SpanRef[]` → `id: number; parentId: number | null`.**
  The chain is resolved client-side from the tree. `maxParentDepth` disappears from
  `captureFlightWindow`'s options.
- `captureFlightWindow` becomes **ancestor-closed** for open spans: after collecting up
  to `maxOpen` contexts from `openEntries`, walk each `ctx.parent` chain and add any
  missing *open* ancestor (`a && !a.closed`). Bounded by `openEntries.size`, so the cap is
  a soft cap — a truncated window never yields a tree with a hole in the middle.
  (Completed spans need no such pass: a parent always finishes *after* its child, so it
  is either still open, or newer in the ring — and the ring is walked newest-first, so
  parents survive the `maxCompleted` cut before their children do. A parent's
  `t1 ≥ child.t1 ≥ windowStartMs`, so it also survives the window filter.)
- **Reorder in `record()`:** `pushCompleted(...)` moves from the last statement to just
  *above* the `slowSpanSubs` notify loop. Same kill-switch/suppression guards apply (both
  early-return above it); the ring write is allocation-free, so the hot path is unchanged.

**Orphans remain possible and are fine**: a detached (fire-and-forget) child can outlive
its parent, and a parent that closed in <5 ms never enters the ring. Such a span has a
`parentId` that resolves to nothing in the window → it renders as a root, flagged
`parent evicted`. Because `parentId < id` always (a parent opens before its child), the
tree is acyclic by construction; the builder additionally refuses to link
`parentId >= id`, so a corrupt payload can never produce a cycle.

Overhead delta: one `++` per span, two integer writes per ring slot, one bounded
ancestor walk at trip time. Nothing new is allocated on the hot path.

### 2. One schema, derived from `SPAN_KINDS` (`plugins/debug/plugins/trace/plugins/spans/shared/flight-window.ts` — new)

The two hand-mirrors collapse into a single plugin-private `shared/` module imported by
both runtimes (precedent: `debug/profiling/plugins/runtime/shared/endpoints.ts`).
`runtime-profiler/core` is zero-dependency by contract, so the zod mirror cannot live
there — `spans/shared/` is its correct home.

```ts
import { SPAN_KINDS, type FlightWindow } from "@plugins/infra/plugins/runtime-profiler/core";

const spanKindSchema = z.enum(SPAN_KINDS);            // ← single source, `cascade` included
export const FlightSpanSchema = z.object({
  id: z.number(), parentId: z.number().nullable(),
  kind: spanKindSchema, label: z.string(),
  t0: z.number(), t1: z.number().nullable(), ageMs: z.number(),
  waitMs: z.number(), childMs: z.number(), selfMs: z.number(),
  waits: z.record(z.number()).optional(),
});
export const FlightWindowSchema = z.object({ atMs: z.number(), open: …, completed: … });

// Bidirectional pin — the one-way assertion is what let `cascade` drift through.
const _a: FlightWindow = {} as z.infer<typeof FlightWindowSchema>;
const _b: z.infer<typeof FlightWindowSchema> = {} as FlightWindow;
```

Read-side parsing returns a **discriminated result**, not `null` (repo rule: failure is a
type, never an absorbable value — the current `parseSpansSection(): FlightWindow | null`
conflates "absent", "legacy" and "corrupt"):

```ts
export type SpansSection =
  | { kind: "ok"; window: FlightWindow }
  | { kind: "absent" }
  | { kind: "legacy" }            // pre-id payload (has `parents`, no `id`)
  | { kind: "invalid"; message: string };
```

Traces captured before this change render an explicit *"legacy spans section — re-capture
to see the call tree"* placeholder rather than the misleading "no spans in flight". The
7-day TTL sweep retires them; `TraceSnapshot.v` stays `2` (the envelope is unchanged —
only a class-owned section's shape moved, which is exactly what the open registry allows).

### 3. Web: the nested waterfall (`spans/web/`)

- **`web/internal/build-tree.ts` (new, replaces `normalize.ts`)** — pure, `bun:test`-covered:
  - `buildSpanTree(snapshot): { totalMs, roots, byId }` — index `open ∪ completed` by `id`
    (no overlap: a span is deleted from `openEntries` before it is pushed to the ring),
    link by `parentId`, roots = `parentId === null` **or** unresolvable parent (orphan),
    children sorted by `t0` then `id`.
  - `flattenTree(roots, collapsed): { node, depth }[]` — depth-first flatten honoring a
    collapsed-id set.
  - `ancestorChain(node, byId): SpanNode[]` — for the detail strip.
  - Window-relative `startMs`/`durationMs` clamping and the leading wait/work segment
    split move here unchanged from `normalize.ts` (still an approximation — waits are
    union totals, not intervals; still labelled as such).
- **`web/components/spans-lane.tsx`** — rewritten: one `MultiSpanLane` per span
  *instance*, its label cell indented by `depth` and prefixed with a kind dot
  (`KIND_CONFIG` kept). A node with children gets a chevron (local `Set<number>` of
  collapsed ids); a header strip carries the span count and Expand-all / Collapse-all.
  Bar click → `onSelect` with `id`, resolved ancestor chain, and the existing
  wait/child/self + `waits` fields. The row whose `id` matches the trigger's `spanId`
  (below) is outlined as the trip.
- **`spans/server/internal/class.ts`** — drops its inline zod, imports the shared schema.
  `captureAtTrip` is otherwise unchanged.

### 4. Trigger carries the tripping span's id

`plugins/debug/plugins/slow-ops/server/internal/install-slow-span.ts` adds
`spanId: span.id` to the `captureTrace` trigger `detail`. Combined with the
`pushCompleted` reorder, the trip span is present in `completed` **and** identifiable, so
the Gantt roots the tree at it. The spans lane narrows `trace.trigger.detail` with a
tolerant `z.object({ spanId: z.number() }).partial()` — absent for non-span triggers
(`op-time`, `stall`, client signals), in which case no row is outlined.

`debug/profiling/plugins/runtime/shared/endpoints.ts`'s `slowSpanSchema` gains
`id` / `parentId` to stay an honest mirror of `SlowSpan`.

## Files

| File | Change |
| --- | --- |
| `plugins/infra/plugins/runtime-profiler/core/recorder.ts` | `nextSpanId`, `EntryContext.id`, `SlowSpan.{id,parentId}`, ring slot ids, `FlightSpan.{id,parentId}` (drop `parents`), ancestor-closed `captureFlightWindow`, `pushCompleted` reorder |
| `plugins/infra/plugins/runtime-profiler/core/recorder.test.ts` | id monotonicity/uniqueness; entry→child `parentId`; leaf `db` under a loader; ancestor closure under `maxOpen`; trip span present in `completed` at notify time |
| `plugins/infra/plugins/runtime-profiler/CLAUDE.md` | flight-recorder substrate section: per-instance identity, ancestor closure, ring ordering |
| `plugins/debug/plugins/trace/plugins/spans/shared/flight-window.ts` | **new** — the one zod mirror (`z.enum(SPAN_KINDS)`, bidirectional pin, `SpansSection` result) |
| `plugins/debug/plugins/trace/plugins/spans/server/internal/class.ts` | import shared schema; delete inline mirror |
| `plugins/debug/plugins/trace/plugins/spans/web/internal/build-tree.ts` | **new** — replaces `normalize.ts` |
| `plugins/debug/plugins/trace/plugins/spans/web/internal/build-tree.test.ts` | **new** — bun:test: linking, orphans, `parentId >= id` refusal, collapse flatten, ordering |
| `plugins/debug/plugins/trace/plugins/spans/web/internal/normalize.ts` | **delete** |
| `plugins/debug/plugins/trace/plugins/spans/web/components/spans-lane.tsx` | rewrite as the depth-indented tree |
| `plugins/debug/plugins/slow-ops/server/internal/install-slow-span.ts` | `detail.spanId = span.id` |
| `plugins/debug/plugins/profiling/plugins/runtime/shared/endpoints.ts` | `slowSpanSchema` += `id`, `parentId` |
| `plugins/debug/plugins/trace/plugins/engine/CLAUDE.md` | rewrite the "Caveats surfaced in the UI" paragraph + step 3 of the blocking-chain walk (the tree is now exact; the ≥5 ms ring floor is the only remaining caveat) |

Reused, not rebuilt: `MultiSpanLane` / `SpanBar` / `GanttContainer` / `formatDuration`
(`@plugins/debug/plugins/profiling/web`), the engine's `Trace.Lane` dispatch +
`TraceSelection` strip channel, `defineTraceEventClass`.

## Verification

1. `./equin build` — then `./equin check` (type-check, boundaries, docs-in-sync).
2. Unit:
   ```bash
   bun test plugins/infra/plugins/runtime-profiler/core/recorder.test.ts
   bun test plugins/debug/plugins/trace/plugins/spans/web/internal/build-tree.test.ts
   ```
3. End-to-end trace with a **known** parent/child pair — the engine's self-test trigger
   opens a synthetic `loader` entry (`engine/server/internal/handle-test-trigger.ts`):
   ```bash
   curl -X POST http://<worktree>.localhost:9000/api/debug/trace/test-trigger
   ```
   Then confirm the persisted section has ids and no `parents`:
   ```sql
   -- mcp query_db
   select snapshot->'events'->'spans'->'completed'->0 from traces order by created_at desc limit 1;
   ```
4. Real nesting: hit a slow endpoint (or use `benchmark_boot` / the boot burst) so an
   `http` → `loader` → `db` chain trips a slow-span threshold, then open
   `http://<worktree>.localhost:9000/debug/traces`, open the newest trace, and check:
   - the trip span is the root row (outlined), not an orphan;
   - `db` rows nest under their loader, loaders under `http`/`flush`;
   - concurrent same-label loaders appear as **separate rows** under their own parents;
   - chevrons collapse/expand; clicking a bar shows the resolved ancestor chain.
   ```bash
   bun e2e/screenshot.mjs --url "http://<worktree>.localhost:9000/debug/traces" --out /tmp/traces
   ```
5. `cascade` regression: a `cascade` span in the window must no longer drop the section —
   confirm a trace captured during a live-state cascade has a non-empty
   `snapshot->'events'->'spans'` and no `trace-section` error report in Debug → Reports.
6. Legacy path: an existing (pre-change) trace row must render the *"legacy spans
   section"* placeholder, not a blank lane.
