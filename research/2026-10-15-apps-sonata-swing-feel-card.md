# Sonata swing: Feel card + canvas pill

## Context

Sonata plays swing (`Score.meta.swing {unit: 8|16, ratio}`, read from MusicXML
`<sound><swing>` / an exact "Swing" marking, applied to playback only by
`swingScore` in the audio + metronome engines). The UI shows none of it: you
can't see a song swings, turn it off, change the feel, or add it to an unmarked
song (MIDI, chord grid).

Direction chosen with the user on the mockup proto-1791407620-ij8o
(`swing=panel`):

- A **Feel** card in the song side panel, right after **Accompaniment**.
  Header: on/off switch (simple toggle — no hold-to-hear). Body: two-beat
  long–short picture against the straight grid, `2:1 · Triplet swing · 67% ·
  33%` readout, 8th/16th segmented control, ratio slider with Light 3:2 /
  Triplet 2:1 / Hard 3:1 stops, and a source line. Collapsed summary:
  `Swing 8ths · 2:1` / `Straight`.
- A **`Swing 8ths 2:1` pill** on the display, beside the Key pill, only while
  the song plays swung.
- A change is **saved per song**; Reset drops it, returning to the score's own
  feel.

## Design

### The value: a per-song override, applied by the score pipeline

Persisted override, three states:

```ts
// document/web/score-settings.ts
export type SwingOverride =
  | { kind: "score" }                       // no row: use the score's own meta.swing
  | { kind: "straight" }                    // forced off
  | { kind: "swing"; swing: Swing };        // forced on, with this feel
export const swingSetting = defineSongSetting<SwingOverride>("swing", { kind: "score" });
```

Added to `ScoreSettings` / `SCORE_SETTINGS`, and applied in the document
pipeline's view memo (`document/web/document.tsx` ~205) as a **meta-only**
transform — notes, onsets and tempo map untouched, so the memo's no-rewind
invariant holds:

```ts
const swung = applySwingOverride(analyzedOrChordMode, swingOverride); // score/core
```

`applySwingOverride(score, o)` (new, `score/core/swing.ts`, beside
`swingScore`): `score` → unchanged; `straight` → `meta.swing` deleted;
`swing` → `meta.swing = o.swing`. Returns the same object when nothing
changes.

Why the pipeline and not the engines: every other per-song setting is applied
there, so `useSession().score.meta.swing` is *the* effective swing for every
reader — the audio engine (`audio/engine/web/components/audio-engine.tsx:473`)
and metronome (`audio/metronome/web/components/metronome-engine.tsx:202`) keep
calling `swingScore(score)` unchanged, the pill reads the same value, and the
future swung piano-roll positions (task-1791993781-5vgk0p) get it for free.

`authoredSwing` for the source line: the card needs the score's own feel
("the score says Swing 8ths 2:1") which the override hides. Keep the authored
value on the score: `applySwingOverride` sets `meta.authoredSwing` (new
optional field on `Score.meta`, `score/core/types.ts`, documented as "the
content's own swing before the per-song override; display only") whenever the
override is not `score`. Copied by the merge helper next to `meta.swing`
(`score/core/helpers.ts:379`).

### New plugin: `sonata/plugins/rich/plugins/swing/`

Copies the `key-mode` precedent (`rich/plugins/key-mode/`) end to end; the card
itself follows `accompaniment` (header actions = switch).

- `shared/resources.ts` — `swingShape = defineExtensionShape({ key: "songId",
  fields: { mode: enumField(["straight","swing"]), unit: intField(), ratio:
  floatField() } })` and `swings = liveCollection("sonata-swing", { row, id:
  "songId" })` (lookup-only). Absent row = `{ kind: "score" }`.
- `shared/endpoints.ts` — `PUT /api/sonata/songs/:id/swing` (body: the
  override, `straight` | `swing{unit,ratio}`, zod-validated: unit ∈ {8,16},
  ratio ∈ [1, 3.5]) and `DELETE /api/sonata/songs/:id/swing` (Reset).
- `server/internal/tables.ts` — `defineExtension(_songs, "swing", swingShape)`
  → `sonata_songs_ext_swing` (FK cascade on song delete); `resource.ts`
  `serveCollection`; `routes.ts` upsert / delete; `server/index.ts`.
- `web/components/swing-observer.tsx` — `useLiveRow(swings, songId)` →
  `useWriteSongSetting(swingSetting)`, failure → `useFailSongSetting`
  (as `key-mode-observer.tsx`). Registered with
  `SonataDocument.SongSetting({ id: "swing-sync", setting: swingSetting, component })`.
- `web/actions.ts` — `saveSwing(songId, override)` /
  `resetSwing(songId)`; each UI write is optimistic `write(songId, v)` then
  save (as `chord-mode-switch.tsx`).
- `web/components/feel-section.tsx` — `Sonata.Section({ id: "feel", label:
  "Feel", icon: symbol(…), area: "player", component: FeelSection, actions:
  FeelSwitch, summary: FeelSummary, useAvailable })`. Available for a library
  song (an override can't be stored for a file document).
  - `FeelSwitch` — `Switch` (`primitives/css/switch`). Off → `straight`; on →
    `swing` with the last feel shown (the authored one, else 8ths 2:1).
  - Body — `SwingPicture` (inline SVG, two beats, pairs at
    `ratio/(1+ratio)`, dashed straight grid; theme tokens only),
    readout, `SegmentedControl` (`primitives/css/toggle-chip`) 8th/16th,
    ratio `Slider` (`primitives/css/slider`, min 1, max 3.5, step 0.05) with
    the three named stops as buttons under it, source line + Reset.
    Controls dim (disabled) while off. Any change while on writes
    `swing{…}`; touching unit/ratio while off turns it on.
  - Source line: no override + swing → "From the score"; no override, none →
    "Not marked in this song — plays straight"; override + authored → "Changed
    by you · the score says Swing 8ths · 2:1 · Reset"; override, no authored →
    "Added by you · Reset". Plus "Only the playback swings — the notation
    stays straight."
  - Shared formatting (`2:1`, `3:2`, `Triplet swing`, `Swing 8ths · 2:1`) in
    `swing/core` (pure, tested), used by the card and the pill.
- `web/components/swing-chip.tsx` — `Sonata.Hud({ id: "swing-chip" })`, same
  look as `rich/plugins/key-chip`, reads `useSession().score.meta.swing`,
  renders nothing when straight. Clicking it is out of scope (HUD chips are
  `pointer-events-none`); it's a read-out.

**Card position** — sections are ordered by registration + the persisted
`sonata.section` reorder config. After build, check Feel lands right after
Accompaniment; if not, fix it in the order's default (not by renaming ids).

### Out of scope

- Swing changes mid-piece (parser still rejects them).
- Drawing swung off-beats in the piano roll — task-1791993781-5vgk0p.

## Files

- `plugins/apps/plugins/sonata/plugins/score/core/{types,swing,helpers,index}.ts` — `authoredSwing`, `applySwingOverride`.
- `plugins/apps/plugins/sonata/plugins/document/web/{score-settings,document,index}.ts(x)` — `swingSetting`, pipeline step.
- `plugins/apps/plugins/sonata/plugins/rich/plugins/swing/**` — new plugin (shared, server, web, core).
- Migration: generated by `./singularity build` (new extension table).

## Verification

- `./singularity test plugins/apps/plugins/sonata/plugins/score` — `applySwingOverride` (score / straight / swing; same object when unchanged; `authoredSwing` kept) and the `swing/core` formatters.
- `./singularity test plugins/apps/plugins/sonata/plugins/document` — pipeline: override reaches `meta.swing`, notes unchanged, settings gate waits for the swing setting.
- `./singularity build`, then on `http://att-1792012845-vkp672.localhost:9000/sonata`:
  - a MusicXML song marked swing: pill shows, card says "From the score"; toggle off → pill gone, plays straight; reload → still off (persisted); Reset → back.
  - a MIDI song: card "Not marked"; turn on, 16ths 3:2 → pill + swung playback; reload persists.
  - screenshot card + pill with `e2e-harness/e2e/screenshot.ts` and compare to the mockup (`compare-diff.ts --name proto-1791407620-ij8o`).
- `query_db` on `sonata_songs_ext_swing` to confirm rows / Reset deletes.
