# Sonata — Chord mode for MIDI songs

## Context

A chord-grid song in Sonata has no notes of its own: the shell's re-voicing step
(`reVoiceChords`) generates the Chords + Bass tracks from the authored chord
annotations, under the global voicing config (realistic voice-leading, octave)
and the per-song rhythm groove (two-hand necklace + figurations). A MIDI song is
the opposite: it carries literal notes, and the chord *analyzer* derives chord
annotations from them — labels only, never notes. So today a MIDI song cannot be
played "as its chords": the Voicing and Rhythm cards are hidden for it, and the
only thing the detected chords drive is the chord label overlay.

The request (from the player at `/sonata/song/<id>`): for MIDI songs, a toggle
that switches to a **chord mode** — stop playing/drawing the original notes and
instead play/draw the detected chords exactly as a chord grid would, with the
same voicing and rhythm options — and a way to keep the original tracks
alongside so individual tracks can still be selected (e.g. hear the melody over
the generated chords).

Decisions taken with the user:

- **One per-song on/off toggle.** Turning it on voices the detected chords onto
  the Chords/Bass tracks and, by default, *deactivates* the original tracks;
  turning it off re-activates them. Which original tracks play in chord mode is
  then chosen in the existing **Tracks** card (hide / mute per track).
- **Original tracks are kept, hidden and muted** — not removed from the score —
  so they stay listed in the Tracks card and any of them can be switched back on.
- **The control lives in the header of a new "Chords" side card** (a
  `Sonata.Section`, like Rhythm's On/Off chip), so it is reachable while the
  card is collapsed.

**Goal:** a MIDI song can be played and displayed as its detected chords, through
the very same voicing + rhythm pipeline a chord grid uses (so the Voicing and
Rhythm cards appear and work), while the original tracks remain individually
selectable in the Tracks card. Remembered per song.

## Design decisions

- **Chord mode is one more pure view transform in `baseScore`.** The score
  pipeline in `shell/web/context.tsx` already composes
  `transpose → reVoiceChords(authored) → inferKeys → spellScore → analyzers`.
  Chord mode appends a step *after* analysis: re-voice **every** chord annotation
  (authored + analyzer-derived) onto the Chords/Bass tracks in a single pass, then
  spell the new notes. It preserves the timeline (chord notes land on the
  chords' existing beats), so it belongs in `baseScore`, never in `contentScore`
  — the no-rewind invariant holds structurally. The analyzer must run first
  (it needs the original notes to detect chords), which is why this is a second
  voicing pass rather than a widening of the first.
- **One voicing chokepoint, one new knob.** `reVoiceChords` grows an
  `include: "authored" | "all"` option (default `"authored"`, byte-for-byte
  today's behaviour). Voicing authored and derived chords together in one pass
  keeps voice-leading continuous across a mixed song (chord grid + MIDI) and
  keeps the Chords/Bass tracks the same two ids the mixer already knows.
- **Deactivation is plain track-mixer state, written by the toggle.** The shell
  pipeline knows nothing about hiding: chord mode only *adds* tracks. The toggle's
  click additionally writes hidden+muted for every original track through a new
  track-mixer **bulk** endpoint (one transaction, one live-state push), and
  clears them on the way out. Original tracks are "every score track that is not
  `chords` / `chords-bass`". A per-track un-hide/un-mute afterwards is an ordinary
  Tracks-card edit and persists like any other. This deliberately overwrites any
  prior hide/mute state on toggle (the user asked for "the toggle
  activates/deactivates the original notes") — noted as a known trade-off.
- **Persistence and topology clone `key-mode` / `transpose`.** The shell owns a
  tiny per-surface scoped store (`chord-mode-store.ts`) read by `baseScore`; a new
  feature plugin `rich/plugins/chord-mode` owns the entity-extension side-table,
  endpoint, push resource, the headless `Sonata.Effect` observer (persisted →
  store), and the section card. Feature → shell, never the reverse.
- **Gates generalise from "authored chord" to "voiced chord".** Voicing and
  Rhythm cards currently gate on `useHasAuthoredChord`. They switch to a new shell
  gate `useHasVoicedChords()` = has an authored chord **or** (chord mode on and
  any chord). So the moment the toggle flips on, the Voicing and Rhythm cards
  appear for the MIDI song, unchanged.
- **The Chords card is a static row.** `defineDetailSections` supports a section
  with no body `component` whose whole content is the header line (`summary`
  and/or `actions`). The card is "Chords" + an On/Off chip. It is available when
  the song has an analyzer-derived chord (there is something to voice) **or**
  chord mode is already on (so a stale "on" can always be switched off).

## Implementation

### 1. `voicing/core/revoice.ts` — the `include` option

- Signature: `reVoiceChords(score, cfg, groove?, opts?: { include?: "authored" | "all" })`.
  Replace the `isAuthoredChord` filter with a predicate chosen from `include`:
  `"authored"` → `type === "chord" && source === "authored"` (today);
  `"all"` → `type === "chord"`. Everything else unchanged (replaces notes on
  `CHORD_TRACK` / `CHORD_BASS_TRACK`, ensures both `TrackMeta`s).
- **Re-target voiced chord annotations.** A derived chord carries
  `target.noteIds` pointing at the original MIDI notes (`chord-analyzer/web/analyze.ts`).
  Once voiced, the honest anchor is the generated notes: for every chord
  annotation the pass voiced, rebuild `target.noteIds` as the ids of the new
  chord-track notes whose `start` falls inside `[start, end)` (one sorted sweep
  over the emitted notes). Otherwise the annotation would keep pointing at
  notes the mixer hides — a dangling reference for the next consumer that reads
  it (none does today; fix it at the source anyway).
- Doc comment: explain the two passes the shell runs and why continuity needs
  one pass over all chords.
- Tests: new `voicing/core/revoice.test.ts` — default ignores derived chords
  (score unchanged when only derived chords exist); `include:"all"` voices derived
  chords onto the two chord tracks and leaves the original tracks' notes intact;
  a second `include:"all"` pass replaces (does not duplicate) chord-track notes;
  voiced annotations' `target.noteIds` name only chord-track notes.

### 2. Shell — store, pipeline step, gates

- `shell/web/chord-mode-store.ts` (new): clone of `key-mode-store.ts` with
  `{ enabled: boolean }`; export `ChordModeStoreProvider`, `useChordMode()`,
  `useSetChordMode()`. Mount the provider in `components/sonata-layout.tsx`
  beside the other stores. Re-export from `shell/web/index.ts`.
- `context.tsx` `baseScore`: read `const chordMode = useChordMode()`; after
  `const analyzed = mergeAnnotations(spelled, derived)`:
  `return chordMode ? spellScore(reVoiceChords(analyzed, voicing, groove, { include: "all" })) : analyzed;`
  Add `chordMode` to the memo deps and a comment paragraph on why the pass is
  after analysis (needs original notes) and why it is safe in the view layer.
  `spellScore` preserves already-spelled notes, so re-spelling is idempotent.
- `score-gates.ts`: add `useHasDerivedChord()` (any `chord` annotation with
  `source === "derived"`) and `useHasVoicedChords()` (`useHasAuthoredChord() ||
  (useChordMode() && useHasChords())`). Export both from the barrel. Keep
  `useHasAuthoredChord` only if a consumer remains after step 4; otherwise remove
  it (dead export).

### 3. `rich/plugins/chord-mode` (new feature plugin)

Clone `rich/plugins/key-mode` for persistence and the observer, `rich/plugins/rhythm-controls` for the header chip.

- `server/internal/tables.ts`: `defineExtension(_songs, "chord_mode", { enabled: boolean().notNull().default(false) })`
  → table `sonata_songs_ext_chord_mode`; export the `.table` for drizzle-kit discovery.
- `shared/resources.ts`: `ChordModeRowSchema { songId, enabled }`, push resource `"sonata-chord-mode"`.
- `shared/endpoints.ts`: `POST /api/sonata/songs/:id/chord-mode` body `{ enabled: boolean }`.
- `server/internal/routes.ts` + `resource.ts` + `server/index.ts`: upsert handler, push loader, `Resource.Declare`.
- `web/actions.ts`: `useSaveChordMode()` via `useEndpointMutation` (user-triggered write → global error toast on failure, like `useSaveRhythm`).
- `web/components/chord-mode-observer.tsx`: `Sonata.Effect`, identical shape to `KeyModeObserver`, writing `useSetChordMode`.
- `web/components/chord-mode-actions.tsx`: the header chip. Let
  `originals = score.tracks.filter(t => t.id !== CHORD_TRACK && t.id !== CHORD_BASS_TRACK).map(t => t.id)`
  (ids from `voicing/core`). The two directions are ordered so the user never
  hears both layers at once (the store flip is instant, the mixer write lands
  through a live-state push a round-trip later — a brief silence beats a brief
  doubling):
  - **Turning on:** `await setTracksActive(songId, originals, false)` (skip when
    empty), then `setChordMode(true)` + `saveChordMode(songId, true)`.
  - **Turning off:** `setChordMode(false)` + `saveChordMode(songId, false)` first
    (chord tracks vanish), then `setTracksActive(songId, originals, true)`.
  The chip renders pending while the awaited write is in flight (`Button`/chip
  auto-pend or a local pending flag), so a double-click cannot interleave.
  Tooltip: "Play the detected chords (Chords + Bass tracks) and turn the original tracks off. Re-enable any track in the Tracks card."
- `web/index.ts`: contributions `Sonata.Effect({ id: "chord-mode-sync" })` and
  `Sonata.Section({ id: "chord-mode", label: "Chords", icon: MdPiano (or similar), area: "player", actions: ChordModeActions, useAvailable })`
  with `useAvailable = () => useHasDerivedChord() || useChordMode()`. No `component`.
- `CLAUDE.md` for the plugin: the design bullets above (why a second pass, why
  deactivation is mixer state, the toggle-overwrites trade-off).

### 4. `rich/plugins/voicing-controls`, `rich/plugins/rhythm-controls`

- Swap `useAvailable: useHasAuthoredChord` → `useHasVoicedChords` in both
  `web/index.ts`; update the doc comments in `voicing-controls.tsx`,
  `rhythm-controls.tsx` and both `CLAUDE.md`s ("shown for songs whose chords are
  voiced by the shell: a symbol source, or chord mode on").

### 5. `track-mixer` — multi-track upsert on the existing route

No parallel bulk route: widen the one partial-patch upsert so it can address
several tracks at once, keeping a single write path.

- `shared/endpoints.ts`: `upsertTrackView` body `trackId: z.string()` →
  `trackIds: z.array(z.string()).min(1)` (same optional patch fields).
- `server/internal/routes.ts`: `handleUpsertTrackView` wraps the per-track
  `insert … onConflictDoUpdate` loop in one `db.transaction` (precedent:
  `infra/attachments/server/internal/define-link.ts`), so a many-track patch is
  atomic and the change feed emits it as one commit.
- `web/actions.ts`: the four existing setters pass `[trackId]`. Add
  `setTracksActive(songId, trackIds, active): Promise<void>` — a single patch
  `{ trackIds, hidden: !active, muted: !active }` that **returns the fetch
  promise** (the chord-mode toggle awaits it to sequence the two layers); the
  existing setters stay fire-and-forget. Export `setTracksActive` from
  `web/index.ts` (today the barrel exports hooks only — document it as the
  sanctioned cross-plugin way to flip tracks).
- `CLAUDE.md`: mention the multi-track patch and its consumer.

### Why no new filtering code is needed

Original notes stay in `score.notes` next to the generated chord notes. That is
inert only because every consumer already filters by the mixer's rollup:
piano-roll (`useHiddenTrackIds`), notation (`useHiddenTrackIds`), piano-keyboard
(hidden + muted), audio engine (`useMutedTrackIds`). Chord mode adds nothing to
those; it relies on that contract.

### 6. Docs / registry

- `./equin build` regenerates the plugin registry, the migration for the
  new side-table, and `docs/plugins-*.md`; never hand-edit those.

## Files

- `plugins/apps/plugins/sonata/plugins/voicing/core/revoice.ts` (+ new `revoice.test.ts`)
- `plugins/apps/plugins/sonata/plugins/shell/web/{chord-mode-store.ts (new), context.tsx, score-gates.ts, index.ts, components/sonata-layout.tsx}`
- `plugins/apps/plugins/sonata/plugins/rich/plugins/chord-mode/**` (new; template: `rich/plugins/key-mode`, `rich/plugins/rhythm-controls`)
- `plugins/apps/plugins/sonata/plugins/rich/plugins/{voicing-controls,rhythm-controls}/web/index.ts`
- `plugins/apps/plugins/sonata/plugins/track-mixer/{shared/endpoints.ts, server/internal/routes.ts, web/actions.ts, web/index.ts}`

## Known trade-offs

- **The toggle overwrites prior per-track state.** Entering chord mode hides +
  mutes every original track regardless of what the user had set; leaving
  re-activates all of them, including a track they had muted before ever
  enabling chord mode. This is the behaviour the user asked for ("the toggle
  activates/deactivates the original notes"); a snapshot/restore of prior state
  is a possible follow-up, not part of this change.
- **Detected chords are as dense as detection makes them** (one window per beat,
  coalesced while the symbol holds). A "chord resolution" knob (snap to bar) is
  a natural follow-up on the Chords card if the result is too busy.

## Verification

1. `./equin build` (background) — migration generated, registry regenerated, deploy receipt `status: ok`.
2. `./equin test plugins/apps/plugins/sonata/plugins/voicing` — the new
   `revoice.test.ts` passes alongside the existing voicing tests.
3. Open a MIDI song. The right column shows a **Chords** card with an Off chip;
   Voicing and Rhythm cards are absent. Click **On**:
   - the roll/notation/audio switch to the generated Chords + Bass tracks;
   - the Tracks card lists the original tracks as hidden + muted and the two new
     tracks as active; un-hide/un-mute one original track and it plays with the chords;
   - Voicing and Rhythm cards appear; changing octave / realistic / a rhythm
     preset re-voices the chords live.
   Reload: the mode and track states persist. Click **Off**: originals return,
   chord tracks vanish, Voicing/Rhythm cards hide.
4. Open a chord-grid song: no Chords card (no derived chords); behaviour unchanged.
5. `query_db` on `sonata_songs_ext_chord_mode` and `sonata_track_view` to confirm rows.
6. Screenshot via `./equin run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts --path /sonata/song/<id> --click "Off"`.
