# Positioned wait bands: waits get a *when*, not just a *how much*

**Date:** 2026-07-09 · **Category:** global (infra/runtime-profiler, debug/trace)
**Builds on:** `research/2026-07-09-global-span-instance-identity-call-tree.md` (per-instance span ids)
**Closes:** the "wait placement is approximate" gap recorded in `research/2026-07-08-global-unified-slow-event-tracing.md` §7

## Context

Every entry span decomposes its wall-clock into `waitMs` / `childMs` / `selfMs`. The wait
component is accumulated by `chargeWait(layer, ms)`, which each concurrency gate calls at
slot acquisition. The recorder knows the exact interval — `end = now(); start = end - ms`
(`recorder.ts:944-945`) — and then **throws the position away**, folding the interval into a
streaming interval-union scalar (`Track { unionMs, prevEnd }`, `recorder.ts:135`).

The consequence is visible in **Debug → Slow Events**. `build-tree.ts:73-80` paints the
whole `waitMs` as a single segment glued to the *start* of the span's bar, and
`spans-lane.tsx:268` labels it `"wait total (position approximate)"`. So today you can read
**what** a span waited on (the per-layer `waits` breakdown) but not **when** — and two
concurrent spans blocked on the same saturated gate show their stalls at two unrelated
places on the timeline instead of lining up at the moment of saturation. That alignment is
the entire diagnostic value of a Gantt: it is how you see that twelve loaders all stopped
dead at t=1.4s because `db-acquire` hit its ceiling.

This plan gives each wait its true position, with two hard constraints:

- **The recorder's hot path must not regress.** `chargeWait` runs once per DB pool acquire.
- **The UI must never draw a bar at a position it does not know.** Where position is
  genuinely unavailable (band budget exceeded, legacy trace), say so — do not guess.

## The idea

Keep `Track`'s scalar union exactly as it is. Alongside each **per-layer** track, keep a
small, bounded, merged list of the intervals that track actually covered — a `WaitBand[]`.
`Track` is the *measure* of the covered set; the band list is the *set itself*, truncated to
a fixed budget.

Three properties make this cheap and correct:

1. **Charges arrive end-ordered by construction** (gates call `onWait` at acquisition;
   this is already the load-bearing premise of the O(1) streaming union — `recorder.ts:249-254`).
   So a new interval never lands before the frontier: appending to the band list is a tail
   check — extend the last band, or push a new one. O(1), no sort, no scan.
2. **Bands are derived from the union's own coverage delta, not from the raw interval.**
   `contribute()` already computes exactly the newly-covered slice `[lo, end]` and discards
   it. Return it instead, and the band records precisely what the scalar counted. Union and
   bands **cannot drift** — `Σ band widths === track.unionMs` holds by construction, and is
   a unit test rather than a hope.
3. **Bands attach where `waits` already attaches** — to the `EntryContext` that was charged.
   No reconstruction, no new duplication axis.

### Why not a global charge ring (the design this replaces)

The tempting alternative — now that spans have per-instance ids — is one process-wide ring
of raw charges `{ownerId, layer, t0, t1}`, one slot per `chargeWait` regardless of ancestor
depth, with each ancestor's bands *reconstructed* on the web as "union of charges owned by
my subtree, clipped to my bar". It is smaller and allocation-free. It is also **wrong**, in
three independent ways:

- **Closed intermediates.** `chargeWait` skips closed ancestors with `continue`, not `break`
  (`recorder.ts:947`) — it can charge a grandparent while the parent is already closed.
  Subtree-reconstruction re-includes that closed parent. Concretely: `flush f`(open) →
  `push p` → `loader l`(open, detached); `p` closes at t=40; `l`'s gate resolves at t=50
  charging `[20,50]`. The recorder charges `f` and `l`, skipping `p`, so `p.waitMs === 0`.
  Reconstruction paints a 20ms band inside `p`'s bar. A phantom.
- **Truncation drops owners before ancestors.** `captureFlightWindow`'s `maxCompleted` cut is
  newest-first, and a parent finishes *after* its child (`recorder.ts:706-712`) — so under
  pressure the **child (the charge's owner) is dropped while its ancestor survives**. The
  charge becomes unattributable exactly in the busy windows we capture traces for.
- **Ring capacity.** `flightRing` gets away with 4096 slots because `FLIGHT_RING_MIN_MS = 5`
  drops nearly every span. The charge stream has no such floor: `chargeWait("db-acquire",
  acqMs)` fires for **every** `pool.query`, warm ones included (`database/server/internal/client.ts:176`),
  plus `read-admit`/`read-coalesce` per resource read. Thousands/sec. A same-sized ring
  covers ~1–2s of a 10s window. Raising the floor to filter it is not an option: 1000 warm
  0.5ms acquires that union into a real 500ms head-of-line stall must not vanish — that is
  the exact bug the feature exists to show.

Merging (bounded bands) rather than flooring (dropped charges) is what keeps size under
control without lying about totals.

Also rejected: **deriving positions from the leaf `db [acquire]` spans already in the
flight ring** — those are emitted only for the no-context fallback and as sub-5ms leaves
that never enter the ring; an in-context `chargeWait` emits no span at all. And **a
`wait-intervals` TraceEventClass with its own engine ring** — `runtime-profiler/core` sits
at the bottom of the DAG and must not import `debug/trace` (its `CLAUDE.md` header), and the
engine's `RingEvent` is a point event `{tMs, data}`, not an interval.

## Data model

```ts
// runtime-profiler/core/recorder.ts — pure arithmetic, no deps (core stays isomorphic)
export interface WaitBand {
  layer: string;
  t0: number; // profiler clock, already clipped to the owning entry's lifetime
  t1: number;
}
```

- `EntryContext` gains `layerBands: Map<string, WaitBand[]>` — lazily allocated per layer,
  exactly like the existing `layerUnions` (`recorder.ts:948-951`). Capped at
  `WAIT_BAND_CAP = 12` bands per `(entry, layer)`.
- `FlightRingSlot` gains `waitBands: WaitBand[] | undefined` **and `waits: WaitBreakdown |
  undefined`**.
- `FlightSpan` gains `waitBands?: WaitBand[]`.

> **Latent bug fixed in passing.** `FlightRingSlot` (`recorder.ts:515-526`) has no `waits`
> field, so today **completed spans carry no per-layer wait breakdown** — only open ones do
> (`recorder.ts:687-691`). `record()` already *receives* the materialized `waits` object
> (`recorder.ts:748`) and drops it on the floor. Storing the reference in the slot costs
> nothing (the object is already allocated in `recordEntrySpan`'s finally) and makes the
> detail strip's per-layer breakdown work for the completed spans that make up most of a
> trace.

### Overflow: drop the smallest, never fill a gap

When a `(entry, layer)` exceeds `WAIT_BAND_CAP`, drop the **smallest** band. The recorder is
conservative in the *under* direction everywhere (`recorder.ts:252-254`), and dropping keeps
the largest stalls — which is what a Gantt is for. Never merge across a gap to make room:
that would paint time the span was not waiting.

Dropping needs **no residual bookkeeping**. `waitMs` remains the authoritative cross-layer
union, so the consumer derives:

```
positionedWaitMs = crossLayerUnion(waitBands)   // ≤ waitMs, always
residualWaitMs   = waitMs - positionedWaitMs    // ≥ 0, always
```

`residualWaitMs > 0` means "this much wait happened, at positions we no longer retain".
The UI reports it as text; it never draws it.

### Ordering subtleties the implementation must honor

- **Store the coverage delta, not the raw interval.** `contribute()` clips to the ancestor's
  `startMs` *and* to the frontier. Each ancestor sees a different clipped slice of the same
  charge. Deriving the band from `contribute`'s return value makes each entry's bands match
  its own scalar exactly, for free.
- **Per-layer bands, cross-layer union for the residual.** Two layers can overlap in time
  (`db-acquire [10,50]` ∪ `read-admit [30,60]`). Their per-layer widths *sum* to 70 while
  `waitMs` is the cross-layer union, 50. Residual math must union across layers, or every
  overlapping span reports a bogus negative-clamped-to-zero residual.
- **Open spans are exact.** `closed` is monotonic, so any ancestor still open at capture was
  open at charge time and got the interval. Reconstruction-free bands need no clamp.
- `resetRuntimeProfile()` must clear the new slot fields alongside `used`
  (`recorder.ts:1238`), and must leave live `EntryContext` bands alone — same rule as the
  tracks.

## Files

### Phase 1 — Recorder (the load-bearing change)

`plugins/infra/plugins/runtime-profiler/core/recorder.ts`

- `contribute()` (`:255`) returns the newly-covered ms (`0` when nothing new). Its
  `__contribute` test export (`:266`) and `recorder.test.ts:687-704` update to assert the
  return value.
- New `pushBand(bands, t0, t1, layer, cap)` next to it; exported as `__pushBand` for direct
  unit test, mirroring `__contribute`.
- `chargeWait()` (`:934-957`): inside the ancestor loop, capture `contribute`'s return for
  the **layer** track and, when `> 0`, `pushBand` into `a.layerBands`. `waitUnion`/`busyUnion`
  are untouched (no bands — they are cross-layer measures). The `ms <= 0` marker charges
  (`git-memo-hit`/`git-memo-miss`) produce no band, since they cover nothing.
- `pushCompleted()` (`:545`): two new params (`waits`, `waitBands`), two new slot writes.
  Update the "zero allocation" comment (`:510-511`) — a completed **entry** span now stores
  two already-allocated references; the per-query leaf path stays allocation-free.
- `recordEntrySpan()` finally (`:1072-1083`): materialize `ctx.layerBands` into a flat
  `WaitBand[]` and thread it, alongside the `waits` object it already builds, through
  `record()` → `pushCompleted()`.
- `captureFlightWindow()` (`:684-730`): emit `waitBands` on open spans (from live
  `ctx.layerBands`) and on completed spans (from the slot), plus `waits` on completed.
- `resetRuntimeProfile()` (`:1238`): clear the new slot fields.

### Phase 2 — Schema

`plugins/debug/plugins/trace/plugins/spans/shared/flight-window.ts`

- `FlightSpanSchema` (`:17`) gains `waitBands: z.array(...).optional()`. **Optional** so
  every existing `traces` row still parses as `ok` — not `legacy`, not `invalid`. No
  migration, no new `SpansSection` variant.
- The **bidirectional compile-time pin** (`:45-46`) forces the schema and the recorder's
  `FlightSpan` to gain the field together, or tsc fails. That is the guard working as
  designed; do not weaken it.

`spans/server/internal/class.ts` needs **no change** — `captureFlightWindow({windowStartMs})`
already carries everything, per-span.

### Phase 3 — Web

`plugins/debug/plugins/profiling/web/components/multi-span-lane.tsx`

`SpanBar.segments` (`:20`) is a *consecutive* `{kind, ms}[]` laid out from a cursor
(`:84-89`) — structurally unable to express a gap. Replace with an absolute overlay list:

```ts
export interface SpanBar {
  id: string;
  startMs: number;
  durationMs: number;
  colorClass: string;
  treatment?: "solid" | "pulse";
  /** Bar-relative, absolutely positioned, may gap and overlap. Painted over the work bar. */
  overlays?: { startMs: number; ms: number; colorClass: string }[];
}
```

Render one solid work bar for the full extent, then the overlays on top. Blast radius is one
call site (`spans-lane.tsx`); `WaitWorkRow` has its own segment type and is untouched.

`plugins/debug/plugins/trace/plugins/spans/web/internal/build-tree.ts`

- `SpanNode.segments` (`:17`) → a discriminated `waitPosition`, because "not captured" and
  "captured, nothing to show" are different facts (repo rule: failure is a type):

```ts
type WaitPosition =
  | { kind: "positioned"; bands: { layer: string; startMs: number; ms: number }[]; residualMs: number }
  | { kind: "unavailable" }; // pre-wait-band trace
```

- `toNode()` (`:63-101`): delete the fake leading-wait construction (`:73-80`); map each
  `span.waitBands` entry to bar-relative, clamped offsets; compute `residualMs` from the
  **cross-layer** union.

`plugins/debug/plugins/trace/plugins/spans/web/components/spans-lane.tsx`

- Bands are colored **per layer** (stable hash into the categorical palette, next to the
  existing per-kind `KIND_CONFIG`), so a saturated gate reads as one color running across
  every stalled row — the alignment this whole plan is for. A legend renders in the detail
  strip beside the existing per-layer `waits` totals.
- The `"wait total (position approximate)"` field (`:267-269`) becomes honest:
  `wait 120ms — 118ms positioned, 2ms unpositioned`. For `{kind:"unavailable"}` it reads
  `position not captured (pre-wait-band trace)` and paints no band at all.

### Phase 4 — Docs

`runtime-profiler/CLAUDE.md` (the wall-clock-decomposition and flight-recorder sections),
`trace/plugins/spans/CLAUDE.md`, and `research/2026-07-08-global-unified-slow-event-tracing.md`
§7 (strike the "wait placement is approximate" risk; note the band budget as its bounded
successor).

## Invariants worth testing

`core/recorder.test.ts` (injectable clock via `installClock`, `:242`):

- **Bands equal the union.** With `cap = ∞`: per-layer `Σ band widths === layerUnions[layer].unionMs`,
  and `crossLayerUnion(bands) === waitMs`. This is the property the whole design rests on.
- **The closed-intermediate case** that killed the reconstruction design — extend the
  existing test at `recorder.test.ts:222`: `p` closed at t=40, detached child charges
  `[20,50]`; assert `p.waitBands` is empty and `p.waitMs === 0`, while the open ancestor and
  the child both carry the band.
- **Overlapping layers**: per-layer bands both present; cross-layer union `=== waitMs <` the
  per-layer sum.
- **Overflow**: `cap + 1` disjoint waits → `cap` bands, smallest dropped, and
  `waitMs - crossLayerUnion(bands)` equals the dropped width. Never fills a gap.
- **Open-span exactness** mid-flight; `resetRuntimeProfile()` clears bands
  (copy `recorder.test.ts:618`).

`spans/web/internal/build-tree.test.ts`:

- Bands land at their true bar-relative offsets (replaces the leading-wait-segment test at
  `:202-212`).
- A span whose bands survive renders them even when its children were truncated out of the
  window.
- A trace with no `waitBands` yields `{kind: "unavailable"}`, not an empty positioned list.

## Verification

```bash
bun test plugins/infra/plugins/runtime-profiler/core/recorder.test.ts
bun test plugins/debug/plugins/trace/plugins/spans
./equin build
```

Then produce a real trace and read it end to end:

```bash
curl -X POST http://<wt>.localhost:9000/api/debug/trace/test-trigger
```

`query_db` the row and confirm the bands actually landed and reconcile with the totals:

```sql
SELECT jsonb_array_length(snapshot->'events'->'spans'->'completed') AS spans,
       jsonb_path_query_array(snapshot->'events'->'spans'->'completed', '$[*].waitBands') AS bands
FROM traces ORDER BY created_at DESC LIMIT 1;
```

Then drive the UI, since the point of this change is what a human sees:

```bash
bun e2e/screenshot.mjs --url http://<wt>.localhost:9000/debug/traces --click "<first row>" --out /tmp/bands
```

Expect: wait bands sitting at their true offsets (not glued to bar starts), the same layer
color aligning across concurrently-stalled rows, no `"position approximate"` string anywhere,
and a pre-existing trace row still rendering (as `position not captured`) rather than
erroring.

Load check — the hot path is the reason to be careful:

```
mcp__singularity__benchmark_boot   # before/after, on main vs the worktree
```

`db-acquire` fires per pool acquire, so a boot burst is the right stress. The added work per
charge is one comparison and (rarely) one array push; watch for regression in the `db` and
`loader` aggregates, not just wall-clock.

## Phases

1. **Recorder + tests** (M). `contribute` returns coverage; bands on `EntryContext`, ring
   slot, `FlightSpan`; `waits` restored for completed spans. Lands green on its own — nothing
   consumes the new fields yet.
2. **Schema** (S). One optional field, bidirectional pin. Old rows unaffected.
3. **Web** (M). `SpanBar` overlays; `build-tree` positioned bands + residual; `spans-lane`
   per-layer colors, legend, honest detail strip.
4. **Docs** (S). Three `CLAUDE.md`/research updates.

Order is strict: 1 → 2 → 3 → 4.
