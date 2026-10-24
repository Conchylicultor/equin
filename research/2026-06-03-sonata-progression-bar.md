# Sonata progression bar (song navigation)

## Context

Sonata can play a score and seek with keyboard arrows, but there is **no visual
timeline** of the whole song and no way to scrub to an arbitrary position with
the mouse. The toolbar only shows `beat 12.34` as text.

We want a **progression bar**: a horizontal, full-width scrubber that represents
the entire song `[0, endBeat]`, shows the playhead, and lets the user
click/drag to seek. Per the user, it must be **extensible**: an open slot where
other plugins contribute timeline markers (bar lines, section regions, key
changes, …) — exactly mirroring how `Sonata.Overlay`/`Sonata.Analyzer` let
plugins layer meaning onto the score.

This is a natural next axis for Sonata's plugin model: input → display →
analyzer → overlay → **timeline marker**.

## Design overview

One new umbrella plugin `progress` under `plugins/apps/plugins/sonata/plugins/`,
with a host child (`scrubber`) plus three marker contributors. Plus two small
supporting edits to `shell` (a transport region slot + an absolute-seek
primitive).

```
plugins/apps/plugins/sonata/plugins/progress/      # umbrella (collapsed, no code)
  plugins/scrubber/   # the draggable bar + defines SonataProgress.Marker slot; contributes Sonata.Transport
  plugins/bars/       # bar/measure tick markers      → SonataProgress.Marker
  plugins/sections/   # section-region bands          → SonataProgress.Marker
  plugins/keys/       # key-change flags              → SonataProgress.Marker
```

### Why this shape

- **Collection-consumer separation** (CLAUDE.md): the `shell` renders a generic
  `Sonata.Transport` slot and never names the progress bar. The `scrubber`
  defines the generic `SonataProgress.Marker` slot and never names bars/keys/
  sections. Adding a future marker (e.g. "loop region", "rehearsal letters")
  is zero edits to existing code.
- **One concern per plugin** (feedback: plugins-are-for-modularity): bars,
  sections, keys are independent marker contributors, mirroring the existing
  `rich/chord-{analyzer,overlay,readout}` trio.

## Changes

### 1. `shell` — new `Sonata.Transport` slot + `seekTo` primitive

**`plugins/apps/plugins/sonata/plugins/shell/web/slots.ts`** — add a render slot
for the horizontal transport region (reorder off; it's a stacked strip, not a
draggable list):

```ts
// TRANSPORT — full-width horizontal strip below the toolbar (progress bar, …).
Transport: defineRenderSlot<{ component: ComponentType }>(
  "sonata.transport",
  { reorder: false, docLabel: (p) => p.id },
),
```

**`plugins/apps/plugins/sonata/plugins/shell/web/context.tsx`** — add an
**absolute** seek primitive. Today only `seekBy` (relative) exists and it
re-anchors playback correctly; the scrubber needs absolute positioning during a
drag without stale-closure math. Refactor so `seekBy` delegates to `seekTo`:

```ts
const seekTo = useCallback((beat: number) => {
  const end = scoreEndBeat(scoreRef.current);
  const next = Math.max(0, Math.min(end, beat));
  setCursorBeat(next);
  reanchor(next);                 // keeps audio/cursor glued while playing
}, [reanchor]);

const seekBy = useCallback(
  (deltaBeat: number) => seekTo(cursorBeatRef.current + deltaBeat),
  [seekTo],
);
```

Add `seekTo` to `SonataContextValue`, the `value` memo, and its deps. `seekTo`
is stable (reads refs internally) so the scrubber's pointer handlers stay
correct mid-drag while playing.

**`shell/web/index.ts`** — barrel already re-exports `Sonata`; no change needed
beyond the new slot being picked up automatically. Update the shell description
string to mention `Transport`.

### 2. `shell` layout — render the transport strip below the toolbar

**`plugins/apps/plugins/sonata/plugins/shell/web/components/sonata-layout.tsx`** —
after the toolbar `<div>` (and before the loader / main area), render:

```tsx
<Sonata.Transport.Render>
  {(t) => <t.component key={t.id} />}
</Sonata.Transport.Render>
```

(Renders nothing when no contributor is present — graceful.)

### 3. `progress/plugins/scrubber` — the bar + marker slot

**`web/slots.ts`** — define the open marker slot. Markers are
absolutely-positioned overlays anchored by a beat→fraction projector, so we use
a plain `defineSlot` + `renderIsolated` (mirrors `piano-roll`'s `OverlayHost`,
not a reorderable list):

```ts
export const SonataProgress = {
  Marker: defineSlot<{
    id: string;
    /** Render absolutely-positioned markers over the track. */
    component: ComponentType<{
      score: Score;
      /** beat → [0,1] position along the track. */
      beatToFraction: (beat: number) => number;
    }>;
  }>("sonata.progress.marker", { docLabel: (p) => p.id }),
};
```

**`web/components/progress-bar.tsx`** — `ProgressBar`:
- `const { score, cursorBeat, seekTo } = useSonata();`
- `endBeat = scoreEndBeat(score)` — reuse the same max-of-(note end, annotation
  end) logic; export `scoreEndBeat` from `score/core/helpers.ts` so both shell
  and scrubber share ONE definition (currently it's private in `context.tsx` —
  promote it to the `score` barrel and have `context.tsx` import it).
- `beatToFraction = (b) => endBeat > 0 ? b / endBeat : 0`.
- Render a `relative` track (`h-2 rounded bg-muted`) with:
  - a filled portion `width: ${frac(cursorBeat)*100}%`,
  - a playhead handle at `left: …%`,
  - a `pointer-events-none absolute inset-0` marker layer mapping
    `SonataProgress.Marker.useContributions()` through
    `renderIsolated("sonata.progress.marker", m, { score, beatToFraction })`.
- Pointer seek: `onPointerDown` captures the pointer, computes
  `fraction = (clientX − rect.left) / rect.width`, calls
  `seekTo(fraction * endBeat)`; `onPointerMove` (while captured) repeats for
  drag-scrub. Uses `e.currentTarget.setPointerCapture(e.pointerId)`.
- Disabled/empty state when `endBeat <= 0`.
- Small beat/bar readout to the side (reuse existing `bars()` count for
  "bar X / Y" if desired; minimal text is fine).

**`web/index.ts`** — contribute `Sonata.Transport({ id: "progress-bar",
component: ProgressBar })` and export `SonataProgress` from the barrel.

### 4. Marker contributors (each: `web/index.ts` + `web/components/*.tsx`)

All three import `SonataProgress` from
`@plugins/apps/plugins/sonata/plugins/progress/plugins/scrubber/web` and `Score`
helpers from `…/score/core`. Each renders an absolutely-positioned layer; clicks
fall through to the scrubber (`pointer-events-none` on the container).

- **`bars`** — `bars(score)` → for each `{ startBeat }` draw a thin tick at
  `left: frac(startBeat)`. Label bar numbers periodically (e.g. every 4th bar or
  when spacing allows) to avoid clutter.
- **`sections`** — `score.annotations.filter(a => a.type === "section")` →
  draw a labeled band from `frac(start)` to `frac(end)` with the
  `SectionData.name`. Distinct subtle background per section (cycle a small
  palette by index).
- **`keys`** — key markers from `score.annotations.filter(a => a.type === "key")`
  plus `score.meta.key` at beat 0 → small flag + `tonic`+`mode` label at each
  change. Renders nothing when absent (no source emits `key` annotations yet —
  the data model supports it; this lights up for free when one does).

### Files

| File | Change |
|---|---|
| `…/score/core/helpers.ts` | **new export** `scoreEndBeat(score)` (promote from context) |
| `…/score/core/index.ts` | re-export `scoreEndBeat` |
| `…/shell/web/slots.ts` | add `Sonata.Transport` render slot |
| `…/shell/web/context.tsx` | add `seekTo`; `seekBy` delegates; import `scoreEndBeat` |
| `…/shell/web/components/sonata-layout.tsx` | render `Sonata.Transport.Render` below toolbar |
| `…/shell/web/index.ts` | description text only |
| `…/progress/package.json` | new umbrella (`"singularity": { "collapsed": true }`) |
| `…/progress/plugins/scrubber/{package.json, web/index.ts, web/slots.ts, web/components/progress-bar.tsx}` | new |
| `…/progress/plugins/bars/{package.json, web/index.ts, web/components/bar-ticks.tsx}` | new |
| `…/progress/plugins/sections/{package.json, web/index.ts, web/components/section-bands.tsx}` | new |
| `…/progress/plugins/keys/{package.json, web/index.ts, web/components/key-flags.tsx}` | new |

`web.generated.ts` registry + per-plugin `CLAUDE.md` autogen blocks + docs are
regenerated by `./equin build` — not hand-edited. Plugin ids derive from
path; **no `id:` in barrels**.

## Sequencing (optional subtasks)

The user offered to split into subtasks. This is cohesive enough for one pass,
but if split, the seam is clean:

1. **Core scrubber** — shell `Transport` slot + `seekTo` + `scrubber` plugin
   with the `SonataProgress.Marker` slot and click/drag seek. (Usable on its
   own; markers optional.)
2. **Markers** — `bars`, `sections`, `keys` contributors (independent, parallel).

## Verification

1. `./equin build` from the worktree; confirm no boundary/lint/migration
   check failures (new slot, new plugins discovered automatically).
2. Open `http://att-1780502848-wj9h.localhost:9000/sonata`, load the MIDI
   source.
3. Scripted Playwright run (`e2e/screenshot.mjs`) to confirm behavior:
   - The progress bar renders below the toolbar with bar ticks.
   - Clicking partway along the bar moves the playhead (assert `beat …` text /
     filled width changes) — before/after screenshots.
   - Dragging scrubs continuously; pressing Play then clicking the bar re-seeks
     without the cursor jumping back (validates `seekTo` re-anchor).
   - If the active source carries section annotations, section bands show with
     labels; bar ticks align to `bars(score)`.
4. Confirm the bar shows an empty/disabled state before a source loads.
