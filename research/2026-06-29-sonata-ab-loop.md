# Sonata A–B section-repeat / loop (practice loop)

## Context

Sonata can only play a song start-to-finish: the transport rAF loop in
`shell/web/context.tsx` advances the cursor and **stops at `endBeat`**. There is
no way to set a loop range and have playback cycle within it, so a learner cannot
drill a single passage over and over — the core practice primitive. Section
markers and a draggable scrubber already exist on the progress bar; we add an
A–B loop region on top of those.

**Outcome:** the user can define an A–B range (drag handles on the bar, one-click
"loop this section", a toolbar toggle, or `L`/`[`/`]` keys); while looping is
enabled, playback (visual cursor + audio) cycles within `[A, B]` instead of
running to the end.

## Design

The whole loop **feature UI** is one self-contained sub-plugin
`progress/plugins/loop`. The only edits outside it are the loop **transport
state + the rAF wrap** in `shell` — which genuinely belong there, alongside
`isPlaying`/`tempoScale`/`seekEpoch`. Plus a small, optional "loop this section"
affordance on the existing `sections` marker.

Loop state model: `loop: { start; end; enabled } | null` (beats).
- `null` → no region; marker hidden.
- defined → region visible; `enabled` gates whether the rAF wraps. A
  defined-but-disabled loop stays visible (faded) so you can keep the markers
  while playing through.

### Part 1 — Shell transport (`shell/web/context.tsx` + `shell/web/index.ts`)

1. **Type** (near `TransportClock`): export
   `interface LoopRange { start: number; end: number; enabled: boolean }`.
   Module constant `const LOOP_MIN_GAP = 1;` (1 beat; never-degenerate).
2. **`SonataContextValue`**: add `loop: LoopRange | null` and
   `setLoop: (next: LoopRange | null) => void`.
3. **State + ref**: `const [loop, setLoopState] = useState<LoopRange|null>(null);`
   `const loopRef = useLatestRef(loop);`
4. **`setLoop` verb** (stable, reads `scoreRef.current`): clamp `start` to
   `[0, end-LOOP_MIN_GAP]`, `end` to `[start+LOOP_MIN_GAP, end]`; `null` clears;
   early-clear if `scoreEndBeat <= 0`.
5. **rAF tick wrap** — insert **before** the `if (beat >= endBeat)` stop check
   (context.tsx ~line 707). Inline the primitives (do **not** call `seekTo` — it
   isn't an effect dep and would muddy the "re-anchor only on play/stop"
   invariant). Self-schedule the next frame like the normal branch:
   ```ts
   const loop = loopRef.current;
   if (loop && loop.enabled && loop.end > loop.start && beat >= loop.end) {
     cursor.setBeat(loop.start, { seek: true });
     reanchor(loop.start);
     setSeekEpoch((n) => n + 1);            // audio restarts from loop.start
     rafRef.current = requestAnimationFrame(tick);
     return;
   }
   ```
   `loopRef`/`reanchor`/`cursor`/`setSeekEpoch` are stable/refs → the effect deps
   `[isPlaying, reanchor, cursor]` are unchanged, the running loop is not
   cancelled. A wrap costs one context re-render (every few seconds) — same as a
   manual seek.
6. **Clear on song change**: add `setLoopState(null)` to the existing
   `useEffect([baseScore, cursor])` reset (beside `setIsPlaying(false)`).
7. **Wire** `loop` + `setLoop` into the `value` object **and** its deps array
   (`loop` is state → in deps; `setLoop` is stable).
8. **Barrel**: re-export `type LoopRange` from `shell/web/index.ts`.

### Part 2 — New plugin `progress/plugins/loop/`

- **`package.json`** — mirror `sections/package.json`.
- **`web/loop-actions.ts`** — shared pure helpers so button + shortcut agree:
  - `defaultLoopAt(score, beat): LoopRange | null` — the section containing the
    playhead if any, else current bar extended `DEFAULT_BARS` (4) bars, clamped;
    null on empty score. Uses `bars(score)` + `scoreEndBeat`.
  - `snapToBars(beat, score)` — nearest bar line (`bars(score)`); Alt bypasses.
  - `toggleLoop({loop,setLoop,seekTo,score,beat})` — if `loop` exists, flip
    `enabled`; else `defaultLoopAt` → `setLoop` + `seekTo(start)`. Shared by the
    toolbar button and the `L` shortcut (one name per concept).
- **`web/components/loop-region.tsx`** — `SonataProgress.Marker` component
  (`{ score, beatToFraction }`; reads `loop`/`setLoop` via `useSonata`). Renders
  in the **top half** of the marker layer (`absolute inset-x-0 top-0 h-1/2`),
  mirroring sections' bottom half so it never blocks rail seeking:
  - Band `[start,end]` (`bg-primary/15` + `ring-1 ring-primary/40`); when
    `enabled===false` → outline-only / `opacity-50`.
  - Two edge handles (`pointer-events-auto cursor-ew-resize`, wide invisible hit
    area) — `onPointerDown`: `e.stopPropagation()` + `setPointerCapture`;
    `onPointerMove` while captured: `beat = clamp((clientX-rect.left)/rect.width,
    0,1)*endBeat`, snap via `snapToBars` unless `altKey`, `setLoop` (clamp +
    min-gap stop the handles crossing).
  - Optional band-middle drag-to-move (`cursor-grab`, `stopPropagation`).
  - Vertical guide lines through the rail via `railBandClass` (pixel-aligned with
    bar ticks), `pointer-events-none`.
  - Hover-revealed clear ✕ (`useHoverReveal`/`hoverRevealClass`,
    `pointer-events-auto`) → `setLoop(null)`.
  - **Critical:** every interactive element calls `e.stopPropagation()` in
    `onPointerDown`, else the parent slider region's `seekToPointer` also fires.
- **`web/components/loop-toggle.tsx`** — `SonataToolbar.End` `IconButton`
  (`MdRepeat`), `variant={loop?.enabled ? "default" : "ghost"}`,
  `disabled={scoreEndBeat(score)<=0}`, `tooltip="Loop"` `shortcut="l"`; onClick →
  `toggleLoop(...)` with `useCursorApi().getBeat()`.
- **`web/components/loop-shortcuts.tsx`** — headless `Sonata.Effect` mirroring
  `controls`' `TransportShortcuts`: `useSurfaceShortcuts`, gated on
  `currentSongId`. `L` → `toggleLoop`; `[` → set loop start at playhead; `]` →
  set loop end at playhead (both `enabled:true`; `setLoop` clamp protects against
  inversion). Lives in the loop plugin (not `controls`) to keep the feature
  atomic.
- **`web/index.ts`** — pure barrel, default `definePlugin` contributing
  `SonataProgress.Marker({id:"loop"})`, `SonataToolbar.End({id:"loop-toggle"})`,
  `Sonata.Effect({id:"loop-shortcuts"})`.
- **`CLAUDE.md`** — stub (autogen fills reference; note the v1 audio-gap caveat).

### Part 3 — Section quick-loop (`progress/plugins/sections/web/components/section-bands.tsx`)

Add a hover-revealed `IconButton` (`MdRepeat`) per band (`pointer-events-auto` on
the button only; band layer stays `pointer-events-none`). `onPointerDown` →
`stopPropagation`; `onClick` → `setLoop({start:a.start,end:a.end,enabled:true})` +
`seekTo(a.start)`. Adds a `useSonata` + hover-reveal dependency to `sections`
(acceptable; bands are the natural click target). Loop region (top half) and
section bands (bottom half) don't overlap.

## Critical files

- `plugins/apps/plugins/sonata/plugins/shell/web/context.tsx` (state, `setLoop`, rAF wrap, song-reset)
- `plugins/apps/plugins/sonata/plugins/shell/web/index.ts` (export `LoopRange`)
- `plugins/apps/plugins/sonata/plugins/progress/plugins/loop/**` (new plugin)
- `plugins/apps/plugins/sonata/plugins/progress/plugins/sections/web/components/section-bands.tsx`

## Reused primitives / helpers

- `scoreEndBeat`, `bars`, `SectionAnnotation` — `.../score/core`
- `SonataProgress.Marker`, `railBandClass`, `RAIL_THICKNESS` — `.../progress/plugins/scrubber/web`
- `Sonata`, `SonataToolbar`, `useSonata`, `useCursorApi`, `LoopRange`, `useLatestRef` — shell barrel
- `IconButton` — `@plugins/primitives/plugins/icon-button/web`
- `useHoverReveal`/`hoverRevealClass` — `@plugins/primitives/plugins/hover-reveal/web`
- `useSurfaceShortcuts` — `@plugins/primitives/plugins/shortcuts/web`

## Risks / edge cases

- **Pointer bubbling** — `stopPropagation` on every interactive loop element +
  the section button (else grabbing a handle also seeks). Load-bearing.
- **seekEpoch re-render** — confirmed harmless (once-per-wrap, rAF not cancelled).
- **Audio gap at wrap** — `seekEpoch` bump reschedules audio from `loop.start`;
  small audible gap, accepted for v1, documented.
- **Loop ending at `endBeat`** — wrap check runs before stop check → loops the
  tail (desired).
- **Cursor past `loop.end` when enabling** — next tick snaps to `loop.start`
  (pulls into the drill range); toggle also `seekTo(start)`.
- **min-gap / empty score** — enforced in `setLoop`; toggle disabled when no song.
- **Two windows** — loop is per-surface context state + focus-scoped shortcuts,
  so loops never cross windows.

## Verification

1. `./equin build`; open `http://<worktree>.localhost:9000` → Sonata, open
   a song with sections.
2. Click a section's loop button → playhead jumps to section start, loop region
   appears (top half), Loop toggle active. Press play → cursor cycles within the
   section; audio repeats.
3. Drag A/B handles → region resizes, snaps to bars (Alt = fine); playback honors
   the new bounds on the next wrap. Clear ✕ removes the loop.
4. Toolbar toggle with no region → creates a default region (current section /
   +4 bars) and seeks to start. Toggling off (faded region) → plays through.
5. Keys: `L` toggles; `[` / `]` set A/B at the playhead.
6. Two Sonata windows: a loop in one doesn't affect the other.
