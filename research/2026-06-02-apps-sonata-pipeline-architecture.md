# Sonata Pipeline Architecture

> Supersedes [`2026-05-18-apps-sonata-plugin-architecture.md`](./2026-05-18-apps-sonata-plugin-architecture.md).
> That doc framed Sonata as a "chord progression player". This doc reframes it
> as a **pipeline**: many input sources → one canonical model → many displays +
> extensible rich annotations. The old chord-player component is **out of scope**
> here; it will be re-expressed later as one Source + one Analyzer/Overlay.

## Context

Sonata is a Synthesia-like piano-roll music app. It must read from **various
sources** (MIDI, sheet music, chord grids, …) and render **rich displays**
(piano roll now; falling-notes / staff / fretboard later) that show not just
notes but **semantic overlays** (chord names, voicings, sections, …).

The user named two extensible axes — **Inputs** and **Display** — and a third
nested one: the rich display itself (chord names, voicings) must be extensible.

The core design problem is decoupling. With N inputs and M displays, wiring each
input to each display directly is N×M integrations. The fix is a **narrow waist**:
a single canonical in-memory model that every input compiles *into* and every
display reads *from*. That collapses N×M to **N+M** — add an input and all
displays show it for free; add a display and all inputs feed it for free. This is
the compiler pattern (many front-ends → one IR → many back-ends).

## The narrow waist: the `Score` IR

`Score` is a plain-TypeScript value type (no framework, no UI) living in a
pure `core` plugin. It has **two layers**, and that split is the load-bearing
idea of the whole design:

- **`notes`** — the literal pitches over time. What plays; what the piano roll draws.
- **`annotations`** — typed, time-ranged *meaning* on top of the notes: chord
  symbols, voicings, section markers, key. This is the "rich display" data.

The two layers fill from **either direction**, which is what makes the abstraction
hold across very different inputs:

| Input | Authored truth | Derived / generated |
|-------|----------------|---------------------|
| MIDI | `notes` | chord/voicing `annotations` (by an Analyzer) |
| Chord grid | chord `annotations` | `notes` (by a voicing strategy) |
| Sheet (later) | both notes **and** annotations natively | — |

Either way the Score ends up holding both layers, so **any display can render
notes, chord names, or both — regardless of which input authored what**. Every
annotation records its `source` (`"authored" | "derived"`) so a display can badge
inferred data and an Analyzer never clobbers authored truth.

### Full IR (chosen depth)

Built fully up front — it's pure data, cheap to get right now, expensive to
retrofit once inputs/displays depend on the shape. MIDI-first forces tempo maps
(real files have tempo changes) and tracks (left/right hand = separate channels)
on day one.

```ts
// plugins/apps/plugins/sonata/plugins/score/core/index.ts
export interface Score {
  meta: { title?: string; key?: KeySignature; pickupBeats?: number };
  tracks: TrackMeta[];          // parts/instruments (MIDI channel, sheet part, …)
  tempoMap: TempoEvent[];       // sorted, piecewise-constant — NOT a single bpm
  timeSigMap: TimeSigEvent[];   // sorted — NOT a single time signature
  notes: Note[];
  annotations: Annotation[];
}

export interface Note {
  id: string;                   // stable identity — annotations target notes by id
  pitch: number;                // MIDI number (always present)
  spelling?: PitchSpelling;     // { step:"C", alter:1, octave:4 } when known/inferred
  start: number;                // quarter-note beats (1.0 = one quarter note)
  duration: number;             // quarter-note beats
  velocity: number;
  track: string;                // -> TrackMeta.id
  voice?: number;               // melodic line within a track
}

export interface Annotation<T extends string = string, D = unknown> {
  type: T;                      // "chord" | "voicing" | "section" | "key" | …
  start: number; end: number;   // beats
  target?: { noteIds?: string[]; track?: string; voice?: number };
  data: D;
  source: "authored" | "derived";
  confidence?: number;
}

export type TempoEvent   = { beat: number; bpm: number };
export type TimeSigEvent = { beat: number; numerator: number; denominator: number };
export interface TrackMeta { id: string; name?: string; instrumentHint?: string }

// Annotation `data` shapes are a discriminated union declared here so overlays
// get type-safe `data` (the one place a little central coupling pays off):
export type ChordData   = { symbol: string; root: number; quality: string };
export type VoicingData  = { label?: string };   // targets notes via target.noteIds
export type SectionData = { name: string };
```

**Pure `core` helpers** (so no plugin re-implements time math):

```ts
export function beatToSeconds(score: Score, beat: number): number; // integrates tempoMap
export function bars(score: Score): { index: number; startBeat: number }[]; // from timeSigMap
export function mergeScores(scores: Score[]): Score; // namespaces track/note ids, unions annotations
export function mergeAnnotations(base: Score, derived: Annotation[]): Score; // analyzer output
```

Design decisions baked in (from review):
- **Tempo & time-sig are maps, not scalars.** A single bpm can't represent any real MIDI file.
- **Bars are derived, never stored** (`bars()` from `timeSigMap`) — storing per-note bar indices desyncs.
- **Ties are not first-class.** A tied note is one `Note` with a long `duration`. Ties are a notation concern resurfaced only by a future staff renderer — keeping them out keeps piano-roll/falling-notes simple.
- **`track` (part) vs `voice` (line within a part) are different axes** — both kept. `track` is also what makes the Score mergeable (see Composition).
- **Stable `Note.id`** so annotations survive re-analysis.
- **MIDI pitch always; `spelling` optional** — MIDI 61 is C#/Db; analyzers/staff need the spelling, authored sheet carries it, raw MIDI infers it.

## The three extension axes (four slots)

The shell defines these in `shell/web/slots.ts` and re-exports the `Sonata`
namespace from `shell/web/index.ts` (barrel purity: `const` lives in `slots.ts`).
Types come from `score/core`. **Slot KIND matters** — a `defineDispatchSlot`
renders one *component* selected by key, so it can't host a pure function like
`compile`; function registries must be `defineSlot` read via `useContributions()`.

| Axis | Slot | Kind | Why |
|------|------|------|-----|
| **Input** | `Sonata.Source` | `defineSlot` | shell calls `compile()` (a non-component fn) on the active source |
| **Display** | `Sonata.Display` | `defineDispatchSlot` keyed by `activeDisplayId` | a display *is* one component selected by id |
| **Rich data** | `Sonata.Analyzer` | `defineSlot` | pure `(Score)=>Annotation[]`; all run, merged into the Score |
| **Rich visual** | `Sonata.Overlay` | `defineSlot` + `renderIsolated` | want ALL overlays whose capabilities fit — not a single dispatch |

```ts
export const Sonata = {
  // INPUT — data registry. LoaderComponent is the UI to provide input
  // (dropzone / text editor); compile turns raw input into a Score.
  Source: defineSlot<{
    id: string; label: string; icon?: IconType;
    LoaderComponent: ComponentType<{ onRaw: (raw: unknown) => void }>;
    compile: (raw: unknown) => Score;            // pure
  }>("sonata.source", { docLabel: (p) => p.label }),

  // DISPLAY — single-active selector. Extra carries metadata the picker enumerates.
  Display: defineDispatchSlot<
    { score: Score; cursorBeat: number },        // props passed to the chosen display
    string,                                       // key = display id
    { id: string; label: string; icon?: IconType; capabilities: Capability[] }
  >("sonata.display", { key: () => activeDisplayId, fallback: NoDisplay }),

  // RICH DATA — pure analyzers; emit only source:"derived".
  Analyzer: defineSlot<{
    id: string;
    analyze: (score: Score) => Annotation[];     // pure, idempotent
  }>("sonata.analyzer", { docLabel: (p) => p.id }),

  // RICH VISUAL — geometry-anchored overlays, capability-filtered.
  Overlay: defineSlot<{
    id: string;
    annotationType: string;                       // which Annotation.type it draws
    requires: Capability[];                        // must be ⊆ display.capabilities
    component: ComponentType<{ projection: Projection; annotations: Annotation[] }>;
  }>("sonata.overlay", { docLabel: (p) => p.id }),

  // (carried over, not the focus) instruments contribute synth params
  Instrument: defineSlot<{ id: string; label: string; synth: SynthSpec }>("sonata.instrument"),

  // existing: free-floating panels (current-chord readout, controls) read shared context
  Section: defineRenderSlot</* existing shape */>("sonata.section"),
};
```

### Why Display is single-active (not a render slot)
Synthesia-like apps are mode *switchers*. Stacking piano roll + staff + fretboard
at once is meaningless and they'd fight over cursor/scroll. The shell owns
`activeDisplayId`; a picker enumerates `Sonata.Display.useContributions()` (via the
`Extra` metadata — collection-consumer clean, never naming a contributor) and sets it.
Split-view later is a *layout* concern above this, not a reason to change the slot.

### The rich-display abstraction: capability negotiation

This is the answer to "the rich display should be extensible too." An Analyzer
produces annotation *data* (display-agnostic). An Overlay renders that data onto a
display (display-specific *geometry*). They're decoupled: analyzers run once into
`Score.annotations`; every display + overlay consumes the merged result.

The trick that makes overlays reusable across displays: a Display publishes a
**projection** via React context, declaring the **capabilities** it offers.

```ts
// Lives in score/core (NOT in the display plugin) so analyzers/overlays import it
// via a barrel and the import graph stays a DAG — see Boundaries.
export type Capability = "time-axis" | "pitch-plane"; // grows when staff/fretboard land
export interface Projection {
  capabilities: ReadonlySet<Capability>;
  viewport: { width: number; height: number; scrollBeat: number };
  beatToX?: (beat: number) => number;    // present iff "time-axis"
  pitchToY?: (pitch: number) => number;  // present iff "pitch-plane"
  noteToRect?: (note: Note) => { x: number; y: number; w: number; h: number };
}
```

An Overlay declares `requires: Capability[]`. A **chord-name** overlay needs only
`"time-axis"` → works on piano roll, falling-notes, AND a future staff. A
**voicing-dots** overlay needs `"pitch-plane"` → piano roll + falling-notes only.
The overlay host (inside each display) renders an overlay only if its `requires` ⊆
the display's `capabilities` **and** the Score has annotations of its type:

```ts
const overlays = Sonata.Overlay.useContributions();
const proj = useProjection();             // this display's published capabilities
overlays
  .filter(o => o.requires.every(r => proj.capabilities.has(r)))
  .filter(o => score.annotations.some(a => a.type === o.annotationType))
  .map(o => renderIsolated("sonata.overlay", o, {
     projection: proj,
     annotations: score.annotations.filter(a => a.type === o.annotationType),
  }));
```

This collapses N displays × M overlays into **N+M**: add a display → it gets every
compatible overlay free; add an analyzer + overlay → every compatible display shows
it free. Zero changes to existing code in both directions. The host filters on
*generic* fields (`requires`, `annotationType`) only — collection-consumer clean.

**MVP scope of the negotiation:** mechanism present, but ship only the two
capabilities the piano roll satisfies. Do **not** invent a capability taxonomy
before a second display (staff) exercises it.

**Not everything rich is an overlay.** A big "current chord" readout or a voicing
text box is a free-floating **`Sonata.Section`** panel reading shared Score+cursor
context — not geometry-anchored. Only things pinned to display coordinates are
overlays. Don't over-model.

## Composition: merge the Score, not the sources

MVP is single-active source (`activeSourceId`, shell-owned). But the IR is already
mergeable via `Note.track`, so the future "chord grid + melody MIDI overlaid" path
is a pure `mergeScores(scores)` call in the shell — each source stays independent
and pure, none knows about merging (collection-consumer clean). **Sources are never
mergeable; the Score is.** Avoid the anti-pattern of a source that takes another
source as input.

## Shared state & playback

`SonataContext` (shell, React state — not core):
`{ score, cursorBeat, isPlaying, activeSourceId, activeDisplayId, setActiveDisplay, … }`.

- **Score derivation** is a memo: compile the active source's raw input →
  `mergeAnnotations(score, analyzers.flatMap(a => a.analyze(score)))`.
- **Transport** is a `requestAnimationFrame` loop (no polling) integrating
  `tempoMap` via `beatToSeconds()` to advance `cursorBeat`. Displays read the cursor.
- **Audio** (audio-engine + `Sonata.Instrument`) plays notes — carried from prior
  design, polished later.

## Plugin tree

```
plugins/apps/plugins/sonata/
  web/index.ts                              # empty namespace (create-app rule)
  plugins/
    score/
      core/index.ts                         # Score, Note, Annotation, TempoEvent, TrackMeta,
                                            # Capability, Projection, beatToSeconds, bars,
                                            # mergeScores, mergeAnnotations  ← the narrow waist (pure)
    shell/
      web/{index.ts, slots.ts, context.ts, components/sonata-layout.tsx}
                                            # owns SonataContext + transport; defines the 5 slots
    piano-roll/
      web/{index.ts, components/}           # first Display; publishes Projection ctx; hosts overlays
    sources/                                # umbrella
      plugins/midi/    {web/index.ts, shared/}   # Sonata.Source — parse .mid → Score   [MVP]
      plugins/chord-grid/ web/index.ts           # Sonata.Source — symbols→notes        [later]
    rich/                                   # umbrella
      plugins/chord-analyzer/ web/index.ts       # Sonata.Analyzer: notes→chord annots  [MVP]
      plugins/chord-overlay/  web/index.ts       # Sonata.Overlay requires ["time-axis"][MVP]
      plugins/voicing-overlay/ web/index.ts      # Sonata.Overlay requires ["pitch-plane"] [later]
    audio/
      plugins/engine/ web/index.ts               # transport→audio                       [later]
```

`score` is a pure `core`-only sub-plugin (no web/server barrel). `sources/` and
`rich/` are empty umbrella namespaces (umbrella rule: 2+ related plugins).

## MVP (Phase 1) — MIDI-first

1. **`score/core`** — full IR (tempoMap, timeSigMap, tracks, note ids, spelling-optional) + helpers.
2. **`shell`** — context + transport + the 5 slot definitions + responsive layout, display picker.
3. **`sources/midi`** — `.mid` file dropzone (`LoaderComponent`) + `compile` → Score (needs a MIDI parser dep, e.g. `@tonejs/midi`).
4. **`piano-roll`** — renders notes on a pitch×time grid; publishes `Projection` with both capabilities; hosts overlays.
5. **`rich/chord-analyzer`** — notes → `chord` annotations (`source:"derived"`).
6. **`rich/chord-overlay`** — `requires:["time-axis"]`, draws chord symbols along the timeline.
7. A **current-chord `Sonata.Section`** readout panel.

**End-to-end proof:** drop a `.mid` → piano roll shows falling/scrolling notes →
chord-analyzer derives symbols → chord-overlay labels them on the timeline → press
play → cursor advances via the tempo map → chord readout tracks the cursor.

**Phase 2+:** chord-grid source + `mergeScores` UI, voicing overlay
(`requires:["pitch-plane"]` — proves capability filtering excludes it from
time-only displays), staff display (forces the capability taxonomy to grow),
instruments/audio polish, pitch-spelling inference, multi-source layering.

## Platform-boundary notes (must hold)

- **`Projection` / `Capability` live in `score/core`, NOT in `piano-roll`.** If they
  lived in the display plugin, analyzers/overlays importing them would deep-import a
  display's web internals, and shell↔piano-roll would risk a cycle. Putting
  display-agnostic contracts in the leaf `core` keeps the graph a **DAG**:
  `score/core` (leaf) ← `shell/web` ← {sources, analyzers, overlays, piano-roll}.
- **Collection-consumer separation:** shell/overlay-host/transport read only generic
  fields — never special-case a source/display/instrument by id.
- **One barrel per runtime / no cross-plugin re-exports:** contributors import slot
  namespace from `@plugins/.../sonata/plugins/shell/web` and types from
  `@plugins/.../sonata/plugins/score/core` — two distinct legal barrels, never proxied.
- **Barrel purity:** slot `const`s stay in `slots.ts`; `index.ts` only re-exports.
- **Function-field slots** (`compile`, `analyze` on a `defineSlot`) are legal —
  sealing only touches the `component` field; other fields pass through
  `useContributions()` fully callable.

## Key reuse

| Primitive | Source |
|-----------|--------|
| `Apps.App` | `@plugins/apps/web` (existing shell already registers `/sonata`) |
| `defineSlot` | `@plugins/framework/plugins/web-sdk/core` |
| `defineRenderSlot` / `defineDispatchSlot` / `renderIsolated` | `@plugins/primitives/plugins/slot-render/web` |
| `Sonata.Section` | already defined in the existing shell `slots.ts` — keep it |

## Verification

1. `./equin build` — all plugins discovered/compiled; `/sonata` registers.
2. Open `http://<worktree>.localhost:9000/sonata`.
3. Drop a `.mid` → piano roll renders notes; chord overlay labels the timeline; current-chord panel populates.
4. Press play → cursor advances correctly through a file **with a tempo change** (validates `tempoMap`/`beatToSeconds`).
5. Multi-channel file → left/right hand render as distinct `tracks`.
6. Capability check (Phase 2): add the voicing overlay (`requires:["pitch-plane"]`); confirm it renders on piano roll and is correctly excluded by a time-only display.
