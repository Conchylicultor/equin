# Sonata piano-roll performance fix

## Context

The Sonata piano roll (the vertical Synthesia-style falling-note display) is **very laggy during playback**, and gets worse the longer a song plays. Investigation found three compounding root causes, all real and confirmed against the code:

1. **`beatToSeconds` clones + sorts the tempo map on every call.**
   `plugins/apps/plugins/sonata/plugins/score/core/helpers.ts:68` does `const events = [...map].sort(...)` on *every* invocation. The `Score.tempoMap` is already a documented "Sorted" invariant (`types.ts:121`), so this allocation + `O(n log n)` is pure waste — and it runs once per note per frame (geometry) and tens of thousands of times per frame (transport, see #2).

2. **The transport rAF tick is `O(beats-since-playback-START)` per frame, and grows unboundedly.**
   `shell/web/context.tsx:277` resets `let beat = anchor.startBeat` (the beat where playback *started*, not the previous frame) and linearly steps `beat += 0.01` calling `beatToSeconds` each step until it reaches the elapsed time. At 120 bpm, 3 minutes in (~beat 360) that's ~36,000 iterations × a sorting `beatToSeconds` **every single frame**. This is the dominant, worsening lag.

3. **Every note div + the 88-key keyboard + overlays re-render every frame.**
   `buildProjection` takes `cursorBeat` (`geometry.ts`), so `projection` is a fresh object each frame → `noteRects` recomputes (maps every note) → all note divs reconcile, and the keyboard/overlays receive a new `projection` prop and re-render. But the scroll is a *pure vertical translation*: `beatToY(beat) = (−seconds(beat)·PX) + (height + cursorSeconds·PX)`. Only the scalar `offset = height + cursorSeconds·PX` varies per frame; per-note layout is cursor-invariant.

**Intended outcome:** constant-cost-per-frame playback regardless of song length or note count — fixing the structural issue (cursor leaking into per-note geometry and an inversion loop that should be closed-form), not just trimming a symptom.

## Approach

### A. New `TempoIndex` primitive in `score/core` (pure, framework-free)

New file `plugins/apps/plugins/sonata/plugins/score/core/tempo-index.ts`:

```ts
export interface TempoIndex {
  beatToSeconds(beat: number): number;
  secondsToBeat(seconds: number): number;
}
export function buildTempoIndex(score: Score): TempoIndex;
```

- Precompute **once**: sorted segments + a `secAtBeat[]` cumulative-seconds prefix sum.
- Both directions `O(log n)` via binary search, zero per-call allocation.
- `seconds(beat)` is piecewise-linear and strictly increasing (bpm > 0), so `secondsToBeat` is exact closed-form inversion. Edge cases (mirror existing `beatToSeconds` semantics, `helpers.ts:61-97`):
  - **Empty tempoMap** → `beat = seconds · 120 / 60` (and forward `seconds = beat·60/120`).
  - **Before first event** → first segment slope backward: `beat = firstBeat + seconds·firstBpm/60`.
  - **Within / after last** → segment-search; the last segment extends to +∞.
- `endBeat` (`scoreEndBeat`) is NOT a tempo-map beat — do **not** bake it into the index; clamp at the call site.

Also in `helpers.ts`: **drop the `[...map].sort(...)`** at line 68 (iterate `map` directly, relying on the sorted invariant) so cold callers (e.g. chord-readout) stay cheap. Export `buildTempoIndex` + `TempoIndex` from `score/core/index.ts` and update `score/CLAUDE.md`'s exports list. This stays within plugin-boundary rules — `score/core` is the shared DAG-leaf barrel that `context.tsx`, `geometry.ts`, and `scheduler.ts` already import.

### B. Transport tick — closed-form inversion (`shell/web/context.tsx`)

- Add `const tempoIndex = useMemo(() => buildTempoIndex(score), [score])` plus a `tempoIndexRef` mirror (like `scoreRef`) so the rAF closure reads the latest.
- In `tick` (lines 267-293) **replace the `while` step loop** with:
  `const beat = Math.min(endBeat, tempoIndexRef.current.secondsToBeat(elapsedSeconds))`.
  Preserve the existing end-of-song branch (`setCursorBeat(endBeat); setIsPlaying(false)` when `beat >= endBeat`).
- Route `reanchor`'s `startScoreSec` (line 188) through `tempoIndexRef.current.beatToSeconds` so there's one tempo-time source. Kills root cause #2 entirely (and most of #1).

### C. Make `Projection` cursor-invariant + translate one layer

**`geometry.ts`** — `buildProjection({ width, height, score })` (drop `cursorBeat`):
- `beatToY(beat) = −tempoIndex.beatToSeconds(beat) · PX_PER_SECOND` (content-space, cursor-invariant).
- `noteToRect`, `pitchToX`, `keys` unchanged otherwise.
- Drop `scrollBeat` from the returned `viewport`.

**`types.ts`** — remove `scrollBeat` from `Projection.viewport` (zero consumers repo-wide; un-derivable once the projection is cursor-invariant, and a screen-coordinate field on a content-space projection is a footgun).

**`piano-roll.tsx`** — the re-render isolation is the load-bearing detail:
- Memoize `projection` on `[lane.width, lane.height, score]` (NOT `cursorBeat`); `noteRects` stays `[projection, score.notes]` → both stable while playing.
- Introduce a small leaf `ScrollLayer` that is the **only** thing reading `cursorBeat`: it computes `offset = lane.height + tempoIndex.beatToSeconds(cursorBeat)·PX_PER_SECOND`, applies `style={{ transform: `translateY(${offset}px)` }}`, and renders cursor-invariant **`children`** (notes + bar lines + `ProjectionProvider`/`OverlayHost`) passed in as stable elements. React bails out re-rendering children whose element identity is unchanged, so notes/keyboard/overlays stop reconciling each frame — only the leaf's transform updates. *(Merely wrapping in a `transform` div without hoisting the `cursorBeat` read into a leaf would NOT isolate the re-renders.)*
- **Split the now-line out of `GridLines`**: bar lines go inside the scroll layer; the fixed now-line (`top: laneHeight`, `z-20`) becomes a sibling **outside** the scroll layer (it's screen-anchored).
- **Drop** the per-note cull (`if (rect.y + rect.h < 0 …) return null`) **and** the `GridLines` bar-line visibility filter — both used screen/cursor coords that are wrong in content-space; the lane's `overflow-hidden` paint-culls offscreen absolutely-positioned divs, so all notes/bars mount once.
- Keep `PitchAxisHost` (keyboard, bottom gutter) and the empty-score affordance **outside** the scroll layer.
- Note: `transform` creates a new stacking context on the scroll layer — overlay `z-30` / notes `z-10` scope within it, and the sibling now-line sits above the whole layer. That's the desired result; verify visually.

### D. Overlay simplification (`chord-overlay.tsx`)

`projection.beatToY` is now content-space and the overlay renders inside the translated layer, so **remove** the cursor/screen cull (`if (y < -20 || y > height + 20) return null`) and the `viewport.height` read. This also removes `cursorBeat` from the overlay contract — a genuine simplification. Update its doc comment.

### E. Scheduler (optional, cheap) — `audio/.../scheduler.ts`

Build `const idx = buildTempoIndex(score)` once and replace the four `beatToSeconds(score, …)` calls with `idx.beatToSeconds(…)`. Behavior identical; avoids `O(n)` sorts at play.

## Critical files

- `plugins/apps/plugins/sonata/plugins/score/core/tempo-index.ts` *(new)*
- `plugins/apps/plugins/sonata/plugins/score/core/helpers.ts` (de-sort `beatToSeconds`)
- `plugins/apps/plugins/sonata/plugins/score/core/index.ts` + `score/CLAUDE.md` (export)
- `plugins/apps/plugins/sonata/plugins/score/core/types.ts` (drop `Projection.viewport.scrollBeat`)
- `plugins/apps/plugins/sonata/plugins/shell/web/context.tsx` (transport tick + reanchor)
- `plugins/apps/plugins/sonata/plugins/piano-roll/web/components/geometry.ts` (cursor-invariant projection)
- `plugins/apps/plugins/sonata/plugins/piano-roll/web/components/piano-roll.tsx` (ScrollLayer leaf, split now-line, drop culls)
- `plugins/apps/plugins/sonata/plugins/rich/plugins/chord-overlay/web/components/chord-overlay.tsx` (drop cull)

## Reused existing code

- `beatToSeconds`, `scoreEndBeat`, `scaleTempo`, `bars` — `score/core/helpers.ts` (the new index mirrors `beatToSeconds`' segment math).
- `PX_PER_SECOND`, `keyLayout` — `geometry.ts` (unchanged).
- `ProjectionProvider` / `useProjection` — `projection-context.tsx` (unchanged contract aside from content-space semantics).

## Verification

1. `./equin build` from the worktree; load `http://<worktree>.localhost:9000` → Sonata, load the MIDI source.
2. **Smoothness over time:** play a multi-minute song; the cursor should stay smooth at minute 3+ exactly as at second 0 (root cause #2). Before the fix it degrades; after, it shouldn't.
3. **Per-frame cost:** with `e2e/screenshot.mjs` (or Chrome DevTools Performance via Playwright), record during playback — confirm note divs are NOT re-created each frame (only the scroll-layer `transform` mutates) and there are no long scripting frames.
4. **Correctness:** notes still land exactly on their keys at the now-line; bar lines + numbers scroll correctly; chord overlay labels track the right beats; seek (arrows / scrubber), tempo nudge (↑/↓), play/pause (Space), and end-of-song stop all behave as before.
5. **Tempo map:** test a source with tempo changes (if available) to confirm `secondsToBeat` inversion and note spacing match the old behavior.
6. `./equin check` passes (migrations/docs/eslint, plugin boundaries).
