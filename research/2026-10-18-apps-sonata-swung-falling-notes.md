# Sonata — falling notes follow the swing

## Context

Swing is audio-only. `audio-engine.tsx` (L497-509) and `metronome-engine.tsx` (L200-207) call `swingScore(...)` before `startScheduling`. Every visual reads the straight `useSession().score`, and the cursor runs on the straight beat axis that the audio timeline shares.

On a swung song, each off-beat note in the piano roll therefore reaches the now-line before it sounds. At 2:1 on 8ths that is a third of an 8th early. Key highlights, the FX (onset tracker) and the pedal lane are early in the same way.

Goal: the roll, the keys, the FX and the pedal lane draw the **performed (swung)** timing. Notation, the scrubber, the loop bounds and the cursor stay straight. The Feel pane gets a per-user toggle for this behaviour, on by default.

Why it works with no cursor or geometry change: `swingScore` warps note *beats*, keeps pair boundaries fixed and leaves `tempoMap` untouched. A swung note at beat b′ is scheduled at straight-timeline beat b′, which is where the straight cursor is when it sounds. Feeding the swung notes to the beat→y projection is the whole fix.

## Design

### 1. One toggle, one hook — owned by `rich/plugins/swing`

The swing plugin owns everything about swing, so it owns the display choice too. Consumers call one hook and never read the config themselves.

- **New file** `rich/plugins/swing/shared/config.ts`:
  ```ts
  export const swingDisplayConfig = defineConfig({ fields: {
    swingFallingNotes: boolField({
      label: "Swing the falling notes",
      description: "Draw the falling notes, key lights and effects where the swung playback sounds them. The notation stays straight.",
      default: true,
    }),
  }});
  ```
  This is a per-user config_v2 value, not a per-song one: it is a viewing preference, not part of the song's feel. Register it in `swing/web/index.ts` with `ConfigV2.WebRegister({ descriptor })`, the same way as `piano-roll/web/index.ts` L56.
- **New hook** `swing/web/use-performed-score.ts`, exported from the barrel:
  ```ts
  /** The score as the falling-note views should draw it: swung like the audio when the toggle is on. */
  export function usePerformedScore(score: Score): Score
  ```
  It is `useMemo(() => on ? swingScore(score) : score, [on, score])`. `swingScore` already returns the same object when the score has no swing or a ratio of 1, so an unswung song keeps memo identity and costs nothing.

### 2. Consumers

| Consumer | File | Change |
|---|---|---|
| Piano roll (canvas, projection, overlays) | `piano-roll/web/components/piano-roll.tsx` L234 | `const performed = usePerformedScore(score)`, then feed `performed` to `unrollLoop` / `songAxis`. Swing comes *before* the loop unroll, in song coordinates (phase from `pickupBeats`), so every unrolled repeat matches what the audio plays each cycle. `songTempo` can stay on `score`, because tempo is unchanged. |
| FX (comets, ripples, shatter) | none | They use `axisScore.notes` through `createOnsetTracker`, so they follow automatically. |
| Key highlights | `piano-keyboard/web/components/piano-keyboard.tsx` L147 | `buildActiveNoteIndex(usePerformedScore(score).notes)`. The speller keeps `score`. |
| Pedal lane | `pedal/plugins/lane/web/components/pedal-lane.tsx` L49 | Read `usePerformedScore(score).pedalEvents`. It sits in the roll's scroll layer and its stated contract is "what you see is what you hear". `swingScore` retimes pedal for the audio, so the lane must follow. |
| Notation, scrubber, bars/keys progress, loop, cursor | none | They keep `useSession().score`. |

I'll check for a dependency cycle before landing: `swing/web` currently imports `document`, `shell`, `session` and `score`, and none of them import `piano-roll`, `piano-keyboard` or `pedal`. `./singularity check plugin-boundaries` confirms it.

### 3. The toggle in the Feel pane

In `rich/plugins/swing/web/components/feel-section.tsx`, replace the closing caption "Only the playback swings — the notation stays straight." with a row:

```
[Switch] Swing the falling notes
         Notation stays straight.
```

- It uses the `Switch` already imported for `FeelSwitch`.
- It reads with `useConfig(swingDisplayConfig)` and writes with `useSetConfig`, the same pattern as `piano-roll/web/components/fx-toggle.tsx`.
- It renders only when `on`. With swing off there is nothing to draw differently, so the toggle would do nothing.

### 4. Docs

- Update the header comment in `score/core/swing.ts`: audio and the falling-note views swing; notation does not.
- Update the swing plugin's `description`, and refresh its CLAUDE.md through the build.

## Verification

- **Unit test** `swing/web/__tests__/use-performed-score.test.tsx`:
  - Toggle on with a swung score gives off-beat starts moved.
  - Toggle off gives the identical object.
  - An unswung score gives the identical object.
- **Manual check** with `./singularity build`, then `browser_*` on a swung song (2:1, 8ths):
  - Pause on an off-beat.
  - Seek so the cursor sits on a swung note's audible beat. Its bar should touch the now-line and its key should be lit.
  - Toggle off in Feel. The bar should jump back to the straight position.
  - Notation and the scrubber should be unchanged in both states.
  - With loop-ahead on, the repeated notes past B should also be swung.
- Run `./singularity check` (boundaries, type-check).
