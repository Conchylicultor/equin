# Sonata — Realistic chord voicings

## Context

Today every chord-symbol source in Sonata (chord-grid, Ultimate Guitar, lyrics
songsheet) plays chords in **root position** — `chordPitches()` stacks the root
at a fixed octave with intervals above it, every chord. Real players don't do
this: they voice each chord close to the previous one (minimal hand motion via
inversions), with a bass note carrying the root. The result today sounds robotic
and jumps around the keyboard.

**Goal:** a "Realistic voicing" mode (ON by default) that voice-leads each chord
to the nearest inversion of the previous one and adds a bass root, applied to all
symbol-based sources. Expose it — plus the existing voicing-strategy picker — in a
new **Voicing** panel that only appears for non-MIDI songs. Persistence is a single
**global** `config_v2` (like the FX toggles / `showNoteNames`).

## Key architectural decision

`Sonata.Source.compile(raw) => Score` is **pure and framework-free** — it cannot
read config and is not reactive. But:

- The shell's `baseScore` `useMemo` in `shell/web/context.tsx:354` *is* reactive
  and already does `compile → mergeScores → inferKeys → spellScore → analyzers`.
- Chord `Annotation<"chord", ChordData>` carries `{ symbol, root, quality, bass?,
  start, end }` — everything needed to (re)generate chord notes from scratch.

Therefore voicing moves **out of `compile()`** and becomes a **single reactive
re-voicing step in the shell**, keyed on a global config. Sources emit chord
**annotations only** (no baked notes); one chokepoint owns chord-note generation.
This makes voice-leading an orthogonal modifier over the rhythm strategy, applied
uniformly to chord-grid, UG, and any future symbol source — zero per-source code.

Voice-leading is **octave/inversion choice only** (pitch-class set is unchanged),
so key inference is unaffected by the toggle.

## New derivation pipeline (`shell/web/context.tsx`)

```
compile each source        // symbol sources emit chord annotations only; MIDI emits notes
  -> mergeScores
  -> reVoiceChords(merged, voicingConfig)   // NEW: authored chord annotations -> chord notes
  -> inferKeys(force: keyAutoDetect)        // notes now exist -> key detection unchanged
  -> spellScore
  -> analyzers (chord-analyzer etc.)
  -> mergeAnnotations
  -> scaleTempo
```

`reVoiceChords` runs **before** `inferKeys`/`spellScore` so chord notes exist for
key detection and get spellings — preserving today's behavior. Add `voicingConfig`
to the `baseScore` memo deps so toggling re-derives the score.

## Components

### 1. Voice-leading engine (pure)

- **`theory/core/voicing.ts`** — add
  `nearestVoicing(rootPositionPitches: number[], prev: number[] | null): number[]`.
  Enumerate octave-shifted inversions of the chord (reuse `invertVoicing`) and pick
  the candidate minimizing total distance to `prev` (sum of nearest-note deltas);
  `prev === null` returns root position. Pure, sits next to `invertVoicing`/`chordPitches`.

### 2. Voicing options + strategies (`voicing/core/voicing.ts`)

- Add `voiceLead?: boolean` to `VoicingOptions` (single flag = "realistic" =
  nearest-voicing **+** bass root).
- Factor a shared helper `placeVoicings(events, opts, tonesOf)` that loops events
  with `prevVoiced` state and returns per-event `{ pitches, bass }`:
  - `tones = tonesOf(ev)` — strategy-specific root-position set (triad slice / full).
  - `voiceLead` ON: `pitches = nearestVoicing(tones, prevVoiced); prevVoiced = pitches`;
    `bass = pcToLowPitch(ev.data.bass ?? ev.data.root)` (finally uses the ignored
    slash-chord `bass` field). OFF: `pitches = tones; bass = null`.
- The 3 existing strategies (`block-triad`, `block-full`, `arpeggio-up`) consume
  `placeVoicings` and render rhythm over `pitches`; the bass note is a block note
  spanning the chord duration (separate `Note` on the same track, `voice: 0`).

### 3. Global config (`voicing/core/config.ts`, new)

`defineConfig` (lives in `core/` because shell + panel both import it; not `shared/`
which is plugin-private):

```ts
export const voicingConfig = defineConfig({
  fields: {
    realistic: boolField({ label: "Realistic voicing", default: true }),
    strategyId: enumField({
      label: "Voicing",
      options: VOICINGS.map((v) => ({ value: v.id, label: v.label })),
      default: DEFAULT_VOICING_ID,
    }),
    octave: floatField({ label: "Octave", default: 4, min: 1, max: 7, step: 1 }),
  },
});
```

`reVoiceChords(score, cfg)` lives in **`voicing/core/revoice.ts`**: filter
`annotations` for `type==="chord" && source==="authored"` → `ChordEvent[]` →
`findVoicing(cfg.strategyId).voice(events, { octave: cfg.octave, voiceLead:
cfg.realistic, track: CHORD_TRACK, idPrefix: "chord" })` → return a new `Score`
with those notes on a single synthesized chord track. Re-export the descriptor,
`reVoiceChords`, and `CHORD_TRACK` from `voicing/core/index.ts`.

### 4. Register the config (both runtimes — required or it reads back `undefined`)

- **`voicing/web/index.ts`** (new): `ConfigV2.WebRegister({ descriptor: voicingConfig })`.
- **`voicing/server/index.ts`** (new): `ConfigV2.Register({ descriptor: voicingConfig })`.

### 5. The Voicing panel (`rich/plugins/voicing-controls/`, new)

A `Sonata.Section({ id: "voicing", label: "Voicing", icon: MdPiano, component,
area: "player" })`. The component:

- `useConfig(voicingConfig)` + `useSetConfig(voicingConfig)`.
- **Visibility:** read `useSonata().score`; `return null` unless the score has any
  authored chord annotation (i.e. a symbol source is loaded — hidden for MIDI-only),
  mirroring the `return null` gating used by existing sections (`chord-progression.tsx:133`).
- Controls: a `ToggleChip` "Realistic voicing" (bound to `realistic`), a strategy
  picker over `VOICINGS`, and an octave stepper — all writing global config.

### 6. Strip voicing from the sources

- **chord-grid** (`sources/.../chord-grid/`):
  - `compile.ts`: stop calling `findVoicing().voice(...)`; emit chord annotations
    (+ tempo/timesig/meta) only. Song meta on save (`durationSec`/`endBeat`) already
    derives from `parseGrid` events, not voiced notes — unaffected.
  - `loader.tsx`: remove the voicing `<select>` and octave `<input>`.
  - `ChordGridRaw`, the `sonata_songs_ext_chord_grid` table, hydrate/save endpoints:
    drop `voicingId` / `octave` (keep `chordText`). **Destructive migration** — per-song
    voicing values are abandoned in favor of the global setting (regenerated by
    `./equin build`; never hand-run drizzle).
- **ultimate-guitar** (`sources/.../ultimate-guitar/compile.ts`): drop the
  hardcoded `findVoicing(DEFAULT_VOICING_ID).voice(...)`; emit chord annotations only.

## Critical files

| File | Change |
|---|---|
| `theory/core/voicing.ts` | add `nearestVoicing` |
| `voicing/core/voicing.ts` | `voiceLead` opt + `placeVoicings` helper + bass; refactor 3 strategies |
| `voicing/core/config.ts` (new) | `voicingConfig` descriptor |
| `voicing/core/revoice.ts` (new) | `reVoiceChords(score, cfg)` + `CHORD_TRACK` |
| `voicing/core/index.ts` | export config, `reVoiceChords`, `CHORD_TRACK` |
| `voicing/web/index.ts` (new) | `ConfigV2.WebRegister` |
| `voicing/server/index.ts` (new) | `ConfigV2.Register` |
| `shell/web/context.tsx` | `useConfig(voicingConfig)`; insert `reVoiceChords` after `mergeScores`; add dep |
| `rich/plugins/voicing-controls/` (new) | `Sonata.Section` panel UI |
| `sources/.../chord-grid/{web/compile.ts,web/loader.tsx,shared,server,...}` | emit annotations only; drop voicingId/octave + migration |
| `sources/.../ultimate-guitar/web/compile.ts` | emit annotations only |

## Reuse (do not re-implement)

- `invertVoicing`, `chordPitches`, `qualityToIntervals` — `theory/core/voicing.ts`, `chords.ts`.
- `findVoicing`, `VOICINGS`, `DEFAULT_VOICING_ID`, `ChordEvent`, `VoicingOptions` — `voicing/core`.
- `defineConfig` (`@plugins/config_v2/core`); `useConfig`/`useSetConfig`/`ConfigV2.WebRegister`
  (`@plugins/config_v2/web`); `ConfigV2.Register` (`@plugins/config_v2/server`).
- `boolField` / `enumField` / `floatField` (`@plugins/fields/plugins/{bool,enum,float}/plugins/config/core`).
- `ToggleChip` (`@plugins/primitives/.../toggle-chip`), section pattern from `rich/plugins/chord-readout`.
- `mergeScores`, `mergeAnnotations`, `Score`/`Note`/`Annotation`/`ChordData` — `score/core`.

## Verification

1. `./equin build` (regenerates the chord-grid drop migration + applies it).
2. Open the song at `http://singularity.localhost:9000/sonata/song/7c0c9447-dfa6-41e7-a704-066ac6ef58b4`
   (a UG/chord song). Confirm the **Voicing** panel appears in the player column.
3. Toggle **Realistic voicing** OFF → play: chords jump to root position (old behavior).
   Toggle ON → play: voiced notes stay in a tight register and a low bass root sounds.
   Use `e2e/screenshot.mjs --click "Realistic voicing"` to capture before/after and
   confirm the piano-roll note placement changes without editing the song.
4. Open a **MIDI** song → confirm the Voicing panel is **hidden** and playback is unchanged.
5. Confirm the chord-grid editor no longer shows the voicing/octave controls and that
   key detection / chord read-out still work for a chord-grid song.
6. `bun test plugins/apps/plugins/sonata/plugins/theory` and add a unit test for
   `nearestVoicing` (e.g. C→G→Am→F stays within a ~12-semitone window vs root position).
7. `./equin check` (boundaries, migrations-in-sync, type-check).
