# Sonata: track-aware piano-keyboard highlight

## Context

The piano keyboard rendered in the roll's bottom gutter
(`piano-keyboard/web/components/piano-keyboard.tsx`) lights up keys that are
sounding at the playback cursor. The recent track-mixer feature added per-track
**color**, **mute** (silences audio), and **hide** (drops notes from the roll),
and both the falling notes and the audio engine already respect this view-state.
The keyboard does **not**: its highlight is computed from a flat
`Set<number>` of pitches with no track awareness, so

- every lit key uses the same `bg-primary` accent instead of the track color;
- a **muted** track's notes still light their keys, though no sound plays;
- a **hidden** track's notes still light their keys, though they're gone from the roll.

Goal: the keyboard should reflect the same per-track color / mute / hidden
view-state as the falling notes and audio — a key lights only for notes on a
track that is neither hidden nor muted, tinted by that track's effective color.

## Current behavior (the one place to change)

`plugins/apps/plugins/sonata/plugins/piano-keyboard/web/components/piano-keyboard.tsx`

```ts
// L74–82 — flat, track-blind
const sounding = useMemo(() => {
  const s = new Set<number>();
  for (const n of score.notes) {
    if (n.start <= cursorBeat && cursorBeat < n.start + n.duration) s.add(n.pitch);
  }
  return s;
}, [score.notes, cursorBeat]);
```

Render then keys off `sounding.has(k.pitch)` to toggle `bg-primary` /
`text-primary-foreground` (white keys L93–112, black keys L114–133).

## Reuse — the track-mixer hooks (no new state, no new hook)

The track-mixer barrel `@plugins/apps/plugins/sonata/plugins/track-mixer/web`
already exports exactly the three reactive hooks the roll and audio consume
(`hooks.ts`):

- `useTrackColorMap(): Map<string, string>` — trackId → effective color (palette
  default or override; every track resolves to a color).
- `useHiddenTrackIds(): ReadonlySet<string>` — tracks dropped from the roll.
- `useMutedTrackIds(): ReadonlySet<string>` — tracks silenced in audio.

All derive from `useTrackMixerEntries` and are memo-stable across animation
frames, so adding them to the per-frame `sounding` recompute is cheap. No cycle
is introduced: track-mixer depends only on `shell/web` + `live-state`, not on
piano-keyboard. This mirrors precedent exactly — the roll imports
`useTrackColorMap` + `useHiddenTrackIds`, audio imports `useMutedTrackIds`; the
keyboard reflects both surfaces, so it imports all three.

## Implementation

Single file: `piano-keyboard/web/components/piano-keyboard.tsx`.

**1. Import the hooks** (alongside the existing `useSonata` import):

```ts
import {
  useTrackColorMap,
  useHiddenTrackIds,
  useMutedTrackIds,
} from "@plugins/apps/plugins/sonata/plugins/track-mixer/web";
```

**2. Turn `sounding` from `Set<number>` into `Map<number, string>`** (pitch →
the color to light it with). Skip notes whose track is hidden or muted; for a
pitch sounded by several eligible tracks, first-in-`score.notes` wins the color
(deterministic; matches the roll, which applies no track ordering):

```ts
const colorMap = useTrackColorMap();
const hiddenIds = useHiddenTrackIds();
const mutedIds = useMutedTrackIds();

// Pitches sounding at the cursor → the color to light each with. A key lights
// only for notes on a track that is neither hidden (gone from the roll) nor
// muted (silent), so the keyboard tracks the same view-state as the falling
// notes and the audio. First eligible note per pitch picks the tint.
const sounding = useMemo(() => {
  const m = new Map<number, string>();
  for (const n of score.notes) {
    if (hiddenIds.has(n.track) || mutedIds.has(n.track)) continue;
    if (n.start <= cursorBeat && cursorBeat < n.start + n.duration && !m.has(n.pitch)) {
      m.set(n.pitch, colorMap.get(n.track) ?? "");
    }
  }
  return m;
}, [score.notes, cursorBeat, colorMap, hiddenIds, mutedIds]);
```

**3. Apply the tint per key.** Replace `const lit = sounding.has(k.pitch)` (both
white-key L94 and black-key L115 branches) with a color lookup, and tint via an
inline `backgroundColor` so it overrides the `bg-primary` class — mirroring the
roll's "track color on top, `bg-primary` as the pre-rollup fallback" pattern
(`piano-roll.tsx` L244/L252):

```ts
const color = sounding.get(k.pitch);   // undefined → not lit
const lit = color !== undefined;
```

White key div (L96–102):

```tsx
<div
  className={`absolute bottom-0 top-0 flex items-end justify-center rounded-b-sm border border-border pb-1 ${
    lit ? "bg-primary" : "bg-background"
  }`}
  style={{
    left: k.center - k.width / 2,
    width: k.width,
    ...(color ? { backgroundColor: color } : null),
  }}
>
```

Black key div (L117–122) — same treatment, keeping its `bg-foreground`
inactive state and `height: "62%"`:

```tsx
style={{
  left: k.center - k.width / 2,
  width: k.width,
  height: "62%",
  ...(color ? { backgroundColor: color } : null),
}}
```

**Label color stays `text-primary-foreground` when lit** (white L104–106, black
L125–127), unchanged. This mirrors the roll, which renders the note-name label
as `text-primary-foreground` over arbitrary track colors with no contrast
computation (`piano-roll.tsx` L263). No luminance/contrast helper exists in the
repo and adding one would be scope creep beyond the established pattern.

## Why this is the clean design

The single source of truth (the track-mixer rollup) gains a third visual
consumer through its existing generic hooks — no new state, no widened API, no
contributor-specific coupling. The keyboard's lit-set already recomputes per
frame, so folding the filter + tint into that memo adds no render path. An empty
override map (pre-load / no song) leaves `colorMap` populated with palette
defaults and both exclusion sets empty, so behavior degrades to "every sounding
key tinted by its palette color" — strictly better than today, never blank.

## Files

- **Modify:** `plugins/apps/plugins/sonata/plugins/piano-keyboard/web/components/piano-keyboard.tsx`
- **Reuse (no change):** `plugins/apps/plugins/sonata/plugins/track-mixer/web/hooks.ts`
  (`useTrackColorMap`, `useHiddenTrackIds`, `useMutedTrackIds`)

The piano-keyboard plugin doc autogen will pick up the new `track-mixer` web
dependency on the next `./equin build`; no hand edits to CLAUDE.md.

## Verification

1. `./equin build` from the worktree, open `http://<worktree>.localhost:9000`,
   go to Sonata, open a multi-track song (e.g. a MIDI source with ≥2 tracks).
2. In the **Tracks** panel: confirm each track's lit keys on the keyboard now
   match that track's color chip (compare against the falling notes' tint).
3. **Mute** a track → its keys stop lighting (and audio is silent, as before);
   unmute → they light again.
4. **Hide** a track → its keys stop lighting (and its notes vanish from the
   roll); unhide → they return.
5. **Recolor** a track → its lit keys retint live (reactive push, no reload).
6. Overlap check: where two visible+audible tracks sound the same pitch, the key
   lights in one track's color (first-in-score-order) — no flicker/crash.
7. Scripted confirm via `e2e/screenshot.mjs` (capture before/after toggling a
   track's mute/hide) if a static visual diff is wanted.
