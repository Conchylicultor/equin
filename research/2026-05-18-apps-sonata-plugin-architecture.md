# Sonata Plugin Architecture

## Context

The user has a monolithic React component (~500 LOC) implementing a chord progression player with piano keyboard visualization, audio synthesis (piano/epiano/synth), BPM-driven sequencing, and AI chord generation. They want it decomposed into an extensible plugin tree within Singularity. The app will evolve into a full Synthesia-like piano app.

Key decisions:
- **Standalone app** with its own rail icon and `/sonata` route
- **Claude via `runClaudePrint`** for AI chord generation (replaces the Gemini API)
- **No `AppShellLayout`** — the app has no sidebar, no toolbar, no miller columns. It's a composable grid of cards, each contributed by a sub-plugin via a single `Sonata.Section` render slot
- **Plugin tree focus** — internal details left to implementing agents

## Plugin Tree

```
plugins/apps/plugins/sonata/
├── package.json                              # Umbrella — namespace only, no runtimes
│
└── plugins/
    ├── chord-engine/                         # Pure TS chord parsing + types
    │   ├── package.json
    │   └── core/index.ts                     # parseChord(), MIDI mapping, interval tables
    │
    ├── audio-engine/                         # Web Audio synthesis layer
    │   ├── package.json
    │   └── web/index.ts                      # AudioEngine class, useAudioEngine hook
    │
    ├── shell/                                # App entry + slot definitions + layout
    │   ├── package.json
    │   └── web/
    │       ├── index.ts                      # Apps.App contribution, re-exports Sonata
    │       ├── slots.ts                      # ALL Sonata.* slot definitions
    │       ├── context.ts                    # SonataContext (shared playback state)
    │       └── components/
    │           └── sonata-layout.tsx          # Custom responsive grid of Sonata.Section cards
    │
    ├── sequencer/                            # BPM-driven playback loop (logic only, no UI)
    │   ├── package.json
    │   └── web/index.ts                      # useSequencer hook
    │
    ├── progression-editor/                   # Chord textarea + parsed chord badges
    │   ├── package.json
    │   └── web/
    │       ├── index.ts                      # → Sonata.Section
    │       └── components/
    │           └── progression-editor.tsx
    │
    ├── playback-controls/                    # Play/Stop/BPM card
    │   ├── package.json
    │   └── web/index.ts                      # → Sonata.Section
    │
    ├── instrument-selector/                  # Instrument picker card, reads Sonata.Instrument
    │   ├── package.json
    │   └── web/index.ts                      # → Sonata.Section
    │
    ├── instruments/                           # Umbrella for instrument sub-plugins
    │   ├── package.json
    │   └── plugins/
    │       ├── piano/
    │       │   ├── package.json
    │       │   └── web/index.ts              # → Sonata.Instrument
    │       ├── epiano/
    │       │   ├── package.json
    │       │   └── web/index.ts              # → Sonata.Instrument
    │       └── synth/
    │           ├── package.json
    │           └── web/index.ts              # → Sonata.Instrument
    │
    ├── visualizers/                           # Umbrella for visualizer sub-plugins
    │   ├── package.json
    │   └── plugins/
    │       └── piano-keyboard/
    │           ├── package.json
    │           └── web/
    │               ├── index.ts              # → Sonata.Section
    │               └── components/
    │                   └── piano-keyboard.tsx
    │
    └── ai-generator/                         # AI chord finder
        ├── package.json
        ├── shared/index.ts                   # Request/response schemas (Zod)
        ├── server/index.ts                   # POST /api/sonata/generate-chords (runClaudePrint)
        └── web/
            ├── index.ts                      # → Sonata.Section
            └── components/
                └── ai-generator.tsx
```

**15 plugins total** (3 umbrellas + 12 leaf plugins).

## Slot Definitions

All defined in `shell/web/slots.ts`, exported as the `Sonata` namespace.

| Slot | Kind | Purpose |
|------|------|---------|
| `Sonata.Section` | `defineRenderSlot` | The primary extension point. Each sub-plugin contributes a card/section to the layout grid. The shell renders all contributions in a responsive CSS grid. |
| `Sonata.Instrument` | `defineSlot` | Non-visual data slot. Each instrument contributes `{ id, label, icon, ...synthParams }`. The instrument-selector card reads these via `.useContributions()`. |

### `Sonata.Section` shape

```ts
Sonata.Section = defineRenderSlot<{
  label: string;
  icon?: ComponentType<{ className?: string }>;
  component: ComponentType;
  area?: "editor" | "player";   // grid placement hint
}>("sonata.section", {
  docLabel: (p) => p.label,
});
```

- `area: "editor"` — left column (progression editor, AI generator, instrument picker, playback controls)
- `area: "player"` — right/main area (chord display, piano keyboard, future: falling notes, fretboard)
- The shell's grid layout groups sections by area and renders them

### `Sonata.Instrument` shape

```ts
Sonata.Instrument = defineSlot<{
  id: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  // Synthesis parameters — shape TBD by implementing agent
}>("sonata.instrument", {
  docLabel: (p) => p.label,
});
```

Non-visual `defineSlot` (not `defineRenderSlot`) because instruments carry synthesis parameters, not UI. The instrument-selector card reads contributions and renders the picker.

## Layout

The shell renders a custom layout — **no `AppShellLayout`**, no sidebar, no toolbar, no miller columns.

```
┌──────────────────────────────────────────────────┐
│  Sonata (header)                                 │
├────────────────┬─────────────────────────────────┤
│  AI Generator  │  Chord Display (badges)         │
│  ──────────    │                                 │
│  Progression   │                                 │
│  Editor        ├─────────────────────────────────┤
│  ──────────    │  Piano Keyboard                 │
│  Tempo         │                                 │
│  ──────────    │                                 │
│  Instrument    │                                 │
│                │                                 │
└────────────────┴─────────────────────────────────┘
```

The shell's `SonataLayout` component:
1. Reads all `Sonata.Section` contributions
2. Groups by `area` ("editor" vs "player")
3. Renders in a responsive CSS grid (`lg:grid-cols-3` — 1 col editor, 2 cols player)

## Shared State

The shell's `SonataContext` (React context) is the single source of truth for playback state:

```
SonataContext
├── chords: ParsedChord[]         ← written by progression-editor
├── activeIndex: number | null    ← written by sequencer
├── activeNotes: number[]         ← written by sequencer
├── isPlaying: boolean            ← written by playback-controls
├── bpm: number                   ← written by playback-controls
├── activeInstrumentId: string    ← written by instrument-selector
├── play() / stop()               ← provided by shell, delegates to sequencer
```

All sub-plugins read from this context. Only the owning plugin writes to its slice.

## Key Reuse from Existing Primitives

| Primitive | Source | Used by |
|-----------|--------|---------|
| `Apps.App` | `@plugins/apps/web` | shell (app registration) |
| `defineSlot` | `@plugins/framework/plugins/web-sdk/core` | shell (Sonata.Instrument) |
| `defineRenderSlot` | `@plugins/primitives/plugins/slot-render/web` | shell (Sonata.Section) |
| `runClaudePrint` | `@plugins/infra/plugins/claude-cli/server` | ai-generator server |

**Not used**: `AppShellLayout` — the app owns its own layout entirely.

## Plugin Dependency Graph

```
chord-engine/core ← progression-editor/web, ai-generator/server
audio-engine/web  ← sequencer/web, instruments/*/web
shell/web         ← ALL other web plugins (slot definitions + context)
sequencer/web     ← shell/web only (composed inside SonataLayout)
```

No cycles. `chord-engine/core` and `audio-engine/web` are leaf nodes with zero framework dependencies.

## Extension Scenarios

**Adding an instrument (e.g. Organ):**
1. Create `plugins/instruments/plugins/organ/web/index.ts`
2. Contribute `Sonata.Instrument({ id: "organ", label: "Organ", ... })`
3. The instrument-selector card automatically picks it up

**Adding a visualizer (e.g. Falling Notes):**
1. Create `plugins/visualizers/plugins/falling-notes/web/index.ts`
2. Contribute `Sonata.Section({ label: "Falling Notes", component: FallingNotes, area: "player" })`
3. The shell renders it in the player area alongside the piano keyboard

**Adding a new editor-side card (e.g. Saved Progressions):**
1. Create `plugins/saved-progressions/web/index.ts`
2. Contribute `Sonata.Section({ label: "Library", component: SavedProgressions, area: "editor" })`
3. Appears in the left column automatically

**No existing code is touched in any case.**

## Server Endpoints

| Method | Path | Plugin | Description |
|--------|------|--------|-------------|
| POST | `/api/sonata/generate-chords` | ai-generator | `{ prompt: string }` → `{ chords: string[] }` via `runClaudePrint` (haiku) |

## Verification

1. `./equin build` — confirms all plugins are discovered, compiled, and the app registers
2. Open `http://<worktree>.localhost:9000/sonata` — the app should appear in the rail and render the card grid
3. Type chords in the editor → they should parse and display as interactive badges
4. Click Play → sequencer should step through chords, piano keyboard should highlight notes
5. Switch instruments → synth parameters should change audibly
6. AI Generator → should call the server endpoint and populate the editor
