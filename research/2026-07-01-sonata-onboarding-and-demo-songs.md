# Sonata: first-run onboarding + realistic demo songs

## Problem

1. **Weak first-run.** An empty Sonata library renders only a one-line
   `emptyState={<>No songs yet — add one to get started.</>}` string
   (`plugins/apps/plugins/sonata/plugins/library/web/components/song-library.tsx:140`).
   No real onboarding: nothing explains the app or gets the user to a playing
   song. The gallery view's built-in fallback then appends a plain button per
   creator — functional but not a designed surface.
2. **Toy demo songs.** The four bundled starters (`starters.ts`) are
   single-track, 8–20-note nursery melodies (Ode to Joy, Twinkle, Für Elise
   opening) that don't demonstrate the player, piano-roll, or grand-staff
   notation convincingly.

## Constraints (from the task)

- **Onboarding must stay source-agnostic.** It must NOT name/hardcode any
  specific input source. It surfaces whatever sources register through the
  generic `Library.Source` registry — adding/removing a source updates the
  landing automatically (collection–consumer separation).
- **Demo content must be realistic MIDI**, not toy songs. The existing design
  authors starters as note data and mints real `.mid` bytes at boot via
  `@tonejs/midi` (no binary blobs in the repo, no licensing concerns) — keep
  that approach; do not check in `.mid` files.

## Current architecture (verified)

- **Song model.** `sonata_songs` row = generic metadata only (`title`,
  `composer`, `durationSec`, `endBeat`). Notes live as `.mid` attachment bytes
  in the MIDI source's `sonata_songs_ext_midi` side-table; `parseMidi` reparses
  them into the canonical `Score` IR (beats, `tracks`, `tempoMap`,
  `timeSigMap`, `notes{pitch,start,duration,velocity,track,voice?}`).
- **Source registry.** Each source registers `Library.Source({ sourceId,
  hydrate, createOption? })` (library/web/slots.ts) + `Sonata.Source(...)`
  (shell). `createOption: CreateOption = { id, label, icon?, description?,
  onSelect }` is the "add a song of this kind" affordance. Today `SongLibrary`
  maps every source's `createOption` into the DataView `creators` "+" menu.
  Three sources register today (MIDI, Chord Grid, Ultimate Guitar).
- **Seeding.** `seedMidiStarters()` (MIDI source `server/onReady`) is a
  content-hash-idempotent boot seeder: it rebuilds each starter's `.mid`, and
  re-mints the attachment + ext row only when the content hash drifts, so the
  `STARTERS` array is the source of truth.

## Design

### Part A — Source-agnostic first-run onboarding

New component `SonataOnboarding` in
`plugins/.../sonata/plugins/library/web/components/onboarding.tsx`. `SongLibrary`
renders it (instead of the `DataView`) only when the songs resource is
**confirmed-empty** (ready + 0 rows); pending/error keep the DataView skeleton,
non-empty keeps the DataView. This is a focused first-run takeover — no
duplicate CTA with the gallery's built-in empty-state buttons.

The onboarding is a centered hero:
- App glyph in a soft rounded badge + headline ("Start your library") + a
  short, **source-neutral** subline (never names MIDI/UG/etc.).
- A responsive grid of **source cards**, one per `Library.Source` contribution
  that carries a `createOption`, built purely from
  `Library.Source.useContributions()` → `{ icon, label, description, onSelect }`.
  Clicking a card runs `onSelect` (create + `openSongImperative` → straight into
  the player). A single shared busy flag disables cards while a create is
  in-flight (mirrors the data-view `CreatorsControl` pattern).
- Composed from existing primitives only (`Card`/`Surface`, `Grid`, `Stack`,
  `Text`, `IconButton`/`Button`) — no ad-hoc spacing/radius/typography.

Because the cards are derived from the registry, adding/removing a source
changes the landing with zero onboarding edits — the required source-agnosticism.

**Supporting polish:** give the MIDI and Chord-Grid `createOption`s a
`description` (UG already has one) so every source card reads well. The
description is a legit `CreateOption` field already shown in the "+" menu.

### Part B — Realistic multi-track demo songs

Extend the starter builder to **multi-track** pieces (two-hand piano → richer
piano-roll color + a real grand staff in the notation lens):

- `StarterTrack = { name?: string; program?: number; notes: StarterNote[] }`;
  `Starter = { id, title, composer, bpm, timeSig?: [num, den], tracks:
  StarterTrack[] }`. The `sequence`/`placed` helpers still return
  `StarterNote[]` (one track's worth).
- `seed.ts`: one `midi.addTrack()` per `StarterTrack` (set `track.name`,
  `track.instrument.number = program`); push a `timeSignature` into
  `midi.header.timeSignatures` when `timeSig` is set (notation reads it for
  barlines); `durationSec`/`endBeat` computed across all tracks.
- **Seed reconciliation:** `STARTERS` becomes fully authoritative — on boot,
  delete managed seed songs (`seed-` id prefix) whose id is no longer in
  `STARTERS`, so removing/renaming a starter propagates (no orphaned toy rows).
  New realistic pieces use new ids; the old toy ids are dropped and reconciled
  away.

**Repertoire** (public-domain, recognizable, each showcases something; correctness
prioritized over quantity):
- **J.S. Bach — Prelude in C major, BWV 846** — the flagship showcase: a fixed
  16th-note broken-chord figuration over 35 well-documented harmonies. Compact
  and fully accurate to encode (figuration pattern × per-bar pitch sets), and
  beautiful in the piano roll. Two hands (bass < middle C, upper ≥ middle C).
- **Erik Satie — Gymnopédie No. 1** (A section) — slow, expressive 3/4 with a
  LH bass+chord waltz under a lyrical RH melody.
- **Beethoven — Für Elise** (full A theme, replacing the 12-note "opening").
- **Rhythm Étude** — KEPT (it's a functional notation fixture exercising
  tuplets / 32nds / grace notes via `placed()`, not a toy melody).

Musical correctness is the main risk — the implementing agent uses the
well-documented note sequences and keeps only pieces it can encode confidently.

## Verification

`./equin build`, then Playwright: (1) delete all songs → confirm the
onboarding hero + source cards render and a card opens the player; (2) open a
demo song → confirm multi-track notes render in the piano roll and a grand
staff in the notation lens.
