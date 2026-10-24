# Sonata: standard sheet-music notation lens

## Context

Sonata today offers two `Sonata.Display` lenses: a Synthesia-style **piano-roll**
(pitch × time falling notes) and a chord-over-lyrics **songsheet** (a reading
view). Neither serves a classically-trained reader who expects **standard staff
notation** (noteheads on a five-line staff, clefs, key/time signatures, barlines,
accidentals, rests). The `Sonata.Display` slot is a swappable-lens registry and
the fully-composed `Score` (transpose + key-inference + spelling already applied)
is handed to every lens, so a third "Notation" lens is the missing option.

This plan adds a **`notation`** Display sub-plugin: a grand-staff (treble + bass)
engraving of the score that follows playback (highlighting the sounding notes and
auto-scrolling), built on **VexFlow** scoped to the lens — mirroring how
`piano-roll` scopes `pixi.js` to itself rather than hoisting a renderer to the
shell.

## Decision: renderer

**Use VexFlow** (`vexflow`, MIT), declared as a dependency of the new lens's own
`package.json` (precedent: `piano-roll` owns `pixi.js`; `sources/midi` owns
`@tonejs/midi`). No notation library exists in the repo today.

Rejected alternatives:
- **Hand-rolled SVG engraving** — beaming, accidental placement, stems, ledger
  lines, rest glyphs and collision avoidance are a research problem; the result
  would look amateur and violate the "feel professional" bar.
- **OpenSheetMusicDisplay (OSMD)** — higher-level (consumes MusicXML, has a
  built-in cursor) but requires serializing the `Score` to verbose MusicXML
  (multi-voice grand staff needs `<backup>`/voice bookkeeping) — a converter of
  equal difficulty to the VexFlow one, plus a heavier dependency and weaker theme
  control. VexFlow gives finer control over theming (draw with theme-token colors
  read from CSS vars) and a lighter footprint.

The genuinely hard part — turning polyphonic, beat-based MIDI-ish `Score` data
into clean measures — is identical for either renderer, so the renderer choice is
made on the rendering+cursor half, which VexFlow wins here.

## Architecture

New plugin: `plugins/apps/plugins/sonata/plugins/notation/`

```
notation/
├── CLAUDE.md
├── package.json                 # { name: "@singularity/plugin-apps-sonata-notation", deps: { vexflow } }
├── shared/
│   └── config.ts                # notationConfig (config_v2): showChordSymbols, splitPitch
├── server/
│   └── index.ts                 # ConfigV2.ServerRegister({ descriptor: notationConfig })
└── web/
    ├── index.ts                 # barrel: Sonata.Display + ConfigV2.WebRegister + Sonata.ViewOption
    ├── internal/
    │   ├── convert.ts           # PURE: Score -> EngraveModel (measures × { treble, bass } voices)
    │   ├── convert.test.ts      # bun:test for the converter
    │   └── durations.ts         # PURE: beat-length -> vexflow duration token(s) + dots + ties
    └── components/
        ├── notation.tsx         # Display component: measure container, render, playhead, autoscroll
        └── engrave.ts           # EngraveModel -> VexFlow draw into an SVG; returns BeatIndex (beat -> {system,x,top,bottom})
```

### Data flow

1. **`convert.ts` (pure, tested)** — `Score -> EngraveModel`:
   - **Staff split**: notes with `pitch >= splitPitch` (default 60 = middle C) go
     to the treble staff, the rest to bass. (v1 ignores `track`/`voice`; one voice
     per staff. Documented caveat.)
   - **Measures**: use `bars(score)` (from `score/core`) for bar boundaries and
     `score.timeSigMap` for the per-measure time signature; `meta.pickupBeats`
     handled by `bars()` already.
   - **Quantize** every note's `start`/`duration` to a 1/16-note grid (configurable
     constant) so durations map to notation values; drop zero-length artifacts.
   - **Chords**: notes on the same staff sharing a quantized start collapse into one
     VexFlow `StaveNote` with multiple keys.
   - **Rests + ties**: within each measure, walk the timeline filling gaps with
     rests (`durations.ts`) and splitting notes that cross a beat/measure boundary
     into tied notes.
   - **Spelling**: each note already carries `spelling?: PitchSpelling` (the shell's
     `spellScore` fills it from the key). Use `spelling.step/alter/octave` →
     VexFlow key string (`"c#/4"`); fall back to `makeKeySpeller(score.meta.key)`
     when absent.
   - **Key signature**: `score.meta.key` (or `effectiveKeyAt`) → VexFlow key sig
     name via `tonicName`/the `KeySignature.tonic`.
   - **Chord symbols** (optional): map `ChordAnnotation`s to a per-measure
     annotation string using `formatSpelledChordSymbol`.

2. **`engrave.ts`** — `EngraveModel + width + theme colors -> { svg drawn, BeatIndex }`:
   - Greedy line-break: accumulate measures into systems sized to the container
     width using VexFlow's `Formatter` minimum widths.
   - Draw each system as a grand staff (treble `Stave` + bass `Stave` + brace +
     connector), clef + key sig + time sig on the first measure of each system /
     on change.
   - Colors read from CSS custom properties on the host element (`--foreground`,
     `--muted-foreground`, `--primary`) and applied to the VexFlow `SVGContext`
     (`setFillStyle`/`setStrokeStyle`), so the lens re-skins with the active theme
     (songsheet approach, NOT the piano-roll's fixed-hex approach).
   - Tag each drawn `StaveNote`'s SVG group with a stable `id`/`data-beat` so the
     overlay can highlight it without re-rendering.
   - Build a **`BeatIndex`**: ascending `{ beat, systemIndex, x, top, bottom }`
     from each note's tick-context x + its system's staff bounds — the notation
     equivalent of piano-roll's `Projection`, but private to this lens.

3. **`notation.tsx`** — the Display component (mirrors songsheet's structure):
   - Measures container width via `useElementSize` (`primitives/element-size`);
     re-engraves (memoized) on `score` or width change.
   - **Playhead** (per-frame, zero re-render — piano-roll's imperative pattern):
     subscribe via `useCursorApi().subscribe`, look up the `BeatIndex` for the
     current beat, and move a single absolutely-positioned playhead line (CSS
     `transform`) within the active system. No React state churn per frame.
   - **Active-note highlight**: on each frame, toggle a `.is-active` class
     (color `--primary`) on the `StaveNote` SVG groups whose notes sound at the
     cursor beat, using `buildActiveNoteIndex(score.notes).at(beat)`.
   - **Auto-scroll** (region-granular, songsheet's pattern): `useCursorSelector`
     to derive the active system index; on change, while `isPlaying`, scroll the
     active system into view (`scrollIntoView({ block: "center" })`).
   - **Click-to-seek**: clicking a notehead/measure seeks via `useSonata().seekTo`
     to that note's beat (reuse the `data-beat` tag).
   - Empty state: `Center` + `Placeholder` ("No notes to display as notation.").
   - `capabilities: []` — a reading view that owns its own overlay; it does NOT
     publish the shell `Projection` (the falling-notes overlays don't apply).

### Contribution (web/index.ts), mirroring piano-roll precedent

```ts
Sonata.Display({
  match: "notation",
  id: "notation",
  label: "Notation",
  icon: MdMusicNote,           // react-icons/md
  capabilities: [],
  component: Notation,
}),
ConfigV2.WebRegister({ descriptor: notationConfig }),
Sonata.ViewOption({ id: "notation", config: notationConfig, fields: ["showChordSymbols"] }),
```

`notationConfig` (config_v2, mirrors `pianoRollConfig`): `showChordSymbols`
(bool, default true), `splitPitch` (int field, default 60 — the treble/bass split).
Server barrel registers it (`ConfigV2.ServerRegister`).

## Reuse (no re-implementation)

- `bars()`, `beatGrid()`, `scoreEndBeat()` — measure/grid layout (`score/core/helpers.ts`).
- `makeKeySpeller`, `PitchSpelling`, `accidentalGlyph`, `effectiveKeyAt` — staff spelling (`score/core`).
- `buildActiveNoteIndex().at(beat)` — cursor-following highlight (`score/core`).
- `tonicName`/`tonicPc` — key-signature naming (`theory/core/key-detect.ts`).
- `formatSpelledChordSymbol` — chord symbols over the staff (`theory/core/chords.ts`).
- Shell hooks (`@plugins/apps/plugins/sonata/plugins/shell/web`): `useSonata`,
  `useCursorApi`, `useCursorSelector`.
- Layout primitives: `Scroll`, `Inset`, `Pin`, `Center`, `Placeholder`, `Stack`,
  `cn`, `useElementSize` — exactly the set songsheet/piano-roll use.

## Caveats / follow-ups (file as tasks)

- **Voice/track separation**: v1 uses a single voice per staff with a fixed
  pitch split. True multi-voice (SATB, independent stems) and per-track staves are
  follow-ups. Document in CLAUDE.md.
- **Quantization**: 1/16 grid; tuplets (triplets), grace notes, and sub-16th
  ornaments are approximated/dropped. Follow-up: tuplet support.
- **Long scores**: all systems render eagerly (songsheet does too). If profiling
  shows jank on very long scores, virtualize systems (follow-up).
- **No edge libs**: confirm `vexflow` installs cleanly under bun; if a specific
  version's ESM entry misbehaves, pin a known-good version in `package.json`.

## Verification

1. `./equin build` from the worktree (runs `bun install`, picks up `vexflow`,
   regenerates the plugin registry + docs, restarts server). Confirm build is green
   and `./equin check` passes (boundaries, plugins-registry-in-sync,
   plugins-doc-in-sync, type-check).
2. `bun test plugins/apps/plugins/sonata/plugins/notation/web/internal/convert.test.ts`
   — converter unit tests (measures, rests, ties, chords, staff split, quantize).
3. App E2E with the Playwright helper (`e2e/screenshot.mjs`):
   - Open a song at `http://<worktree>.localhost:9000/sonata/song/<id>`, click the
     Display picker → **Notation**, screenshot the rendered grand staff.
   - Press play; capture before/after to confirm the playhead moves, active notes
     highlight, and the active system auto-scrolls into view.
   - Toggle the view-option chord-symbols field and confirm chord symbols appear.
   - Switch transpose and confirm the key signature + noteheads shift (the score
     prop is already transposed).
4. Theme check: toggle light/dark and confirm staff/notes recolor (CSS-var-driven).
```
