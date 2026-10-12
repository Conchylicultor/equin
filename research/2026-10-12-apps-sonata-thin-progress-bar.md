# Sonata — thin progress bar

## Context

The Sonata player's progress bar (`plugins/apps/plugins/sonata/plugins/progress`)
stacks a chord lane, section bands, a loop band, bar ticks and key bars into
~60px; the strata compete and most of it reads as noise. The user iterated a
redesign in two prototypes — **proto-1791757926-7m9lfx** (exploration, the
"chapters / slim / thin key line" variant won) and **proto-1791407620-ij8o**
(the final compact version inside the player mock). This plan ports the ij8o
bar to the real app.

Target (ij8o, two-row layout):

- **No chord lane.**
- **Rail**: 6px, thickens to 10px on hover/drag; split into one segment per
  section ("chapters", 3px gaps). The hovered chapter thickens a little more.
- **Bar notches** cut into the rail at every bar line, always visible; every
  4th bar stronger.
- **Key changes**: a thin (1.5px) key-coloured line, only ~3px taller than the
  hot rail. No glow, no chip on the rail.
- **Label row under the rail (13px)**: section names (coloured dot, current one
  bold, click → seek, hover → "loop this section"); key names folded in —
  a key that changes where a section starts sits inside that section's label
  (`Answer G♯m`); the starting key muted after the first label (`Theme B`); a
  mid-section change gets its own small name at its line.
- **A–B loop**: band over the rail zone, draggable ends (bar-snapped, Alt =
  free — existing), the rail outside the loop dimmed while enabled, × to clear
  on hover.
- **Handle**: round accent knob (as today).
- **Hover preview**: time + bar number, then section · key; near a key line
  the preview snaps onto it and reads "Key change → D major".
- **Time**: elapsed left of the bar, total right (as in ij8o's transport).
- Total height ≈ 16px zone + 13px labels — the strip's height is set by the
  play button again.

## Design

The scrubber stays the owner of the generic surface; every contributor is
reached only through `SonataProgress.*` slots (collection-consumer
separation — the scrubber never names sections, keys or bars).

### Slots (`scrubber/web/slots.ts`)

| Slot | Shape | Used by |
|---|---|---|
| `Marker` (exists) | component over the rail zone | bars (notches), keys (lines), loop (band/handles/shade) |
| `Chapters` (new) | `{ id, chapters(score) → {start,end}[] }` | sections |
| `Label` (new) | `{ id, order, labels(score) → ProgressLabel[] }`, `ProgressLabel = { beat, key, node: ReactNode, end?: number }` | sections, keys |
| `Describe` (new) | `{ id, order, line: "head" \| "body", describe(score, beat) → ReactNode \| null, snapBeats?(score) → number[] }` | bars (`Bar 52`, head), sections (`● Chorus`, body), keys (`C major` / `Key change → D major`, body + snap) |

- **Chapters**: the scrubber splits the rail into segments from the first
  contributor returning a non-empty list; none → one segment. Fill is one
  `scaleX` layer per segment, still painted imperatively from the cursor
  subscription (no per-frame React).
- **Label lane**: the scrubber gathers every contributor's labels, groups them
  by `beat` (contribution `order` within a group), and lays each group out at
  `pct(beat)` with a width up to the next group (or `end`). A group renders its
  nodes inline — that is what folds `G♯m` into `Answer` with no knowledge of
  either. Narrow groups hide text via a container query (name, then dot).
- **Describe**: the scrubber owns the preview box (time from the tempo index),
  appends `head` items after the time and `body` items on the second line.
  Hover position snaps to any contributor's `snapBeats` within 7px (preview
  only; seeking is never snapped).

All three new slots are plain `defineSlot` read with `useContributions()`,
like `Marker`.

### Geometry (`scrubber/web/rail-geometry.ts`)

- `RAIL_HEIGHT` becomes `var(--sonata-rail-h)`; the scrubber sets it to 6px,
  10px while hovered/dragging (CSS on the slider, no React state). Every
  on-rail mark using `RAIL_BAND_Y` follows the hover thickening for free.
- New `railBand(outset: number): Extent` — the rail band at its hot height
  plus `outset` px each side (key lines use `railBand(3)`, loop handles/shade
  `railBand(3)`).
- `ZONE_HEIGHT = "1rem"`, `LABEL_LANE_HEIGHT = "0.8125rem"` (13px).
- Delete `LANE_HEIGHT` / `LANE_ABOVE_Y` (only the chord lane used them).

### Per plugin

- **scrubber** — `progress-bar.tsx`: layout `[elapsed][slider][total]`;
  slider = zone (rail segments + marker layer + ghost line + handle) + label
  lane + preview. Remove the `paddingTop: LANE_HEIGHT` / `py-md` headroom.
  Keep the imperative paint path, the pointer-capture seek and the ARIA
  slider; add `aria-valuetext` from time.
- **chords** — delete the plugin (`plugins/progress/plugins/chords`). The
  shared chord-label mode (`rich/chord-label`) stays; it has other users.
- **bars** — notches: 1px, `bg-background` at 45% (85% every 4th bar), drawn
  over the fill so they cut the whole rail. Contributes `Describe` head
  `Bar n` via `bars(score)`.
- **sections** — drop `SectionBands`. Contribute `Chapters` (section ranges),
  `Label` (a `<SectionLabel>` node: categorical dot keyed by the section name
  minus trailing digits, so every "Chorus" shares a colour; bold while current
  via `useCursorSelector`; click → `seekTo(start)`; hover-revealed loop
  `IconButton` → `setLoop`) and `Describe` body (`● name`).
- **keys** — `KeyFlags` draws only *changes* (skip the starting entry at
  beat 0) as a 1.5px line, `railBand(3)`, key tone at 85%, a wider invisible
  hit box kept pointer-transparent. Contributes `Label` (every
  `collectKeyEntries` entry; start one muted), `Describe` body + `snapBeats`.
- **loop** — `LoopRegion`: band + handles move from the top half into the
  rail zone (`railBand(3)`), the two rail guides go (the handles sit on the
  rail now), two shade boxes over the rail outside `[A, B]` while enabled
  (`bg-background/60`). Drag/snap/clear logic unchanged. The roll overlay,
  toggle and shortcuts are untouched.

### Key colour

No themeable "key" token exists. Use the `warning` palette token (amber,
themeable, already in every theme) through one constant in the keys plugin
(`KEY_TONE`), so the choice lives in one place and can move to a dedicated
token later.

## Files

- `plugins/apps/plugins/sonata/plugins/progress/plugins/scrubber/web/{slots.ts,rail-geometry.ts,index.ts,components/progress-bar.tsx}` (+ new `components/label-lane.tsx`, `components/hover-preview.tsx`)
- `…/progress/plugins/{bars,keys,sections}/web/**` — rewritten contributions
- `…/progress/plugins/loop/web/components/loop-region.tsx`
- delete `…/progress/plugins/chords/`
- generated registries/docs regenerate on `./singularity build`

Reuse: `Placed`/`pct`/`Layer` (`primitives/css/coords`, `layer`), `Clip`,
`hoverRevealGroup`/`hoverRevealTarget`, `IconButton`, `useCursorSelector` /
`useCursorApi` / `useSession` (`sonata/session`), `bars()`,
`collectKeyEntries`, `buildTempoIndex`, `scoreEndBeat` (`sonata/score/core`),
`snapToBars` (loop).

## Verification

1. `./singularity build` (checks incl. `plugin-boundaries`, `type-check`,
   eslint `no-adhoc-layout`, `plugins-doc-in-sync`).
2. `./singularity test plugins/apps/plugins/sonata/plugins/progress` — add a
   pure test for the label-lane grouping (same-beat folding, ordering, widths)
   and for the hover snap.
3. Screenshots of `/sonata/song/song-bad4797a-…` with `screenshot.ts`
   (rest, hover over a key line via a small e2e flow, loop on) and
   `compare-diff.ts --name proto-1791407620-ij8o` for the bar region.
4. Run the existing `loop/e2e/loop-drag.ts` (handles moved into the rail zone).
5. Check the render-loop detector stays quiet during playback (no new
   per-frame React work: the current-section bold and preview use
   `useCursorSelector` / hover-only state).
