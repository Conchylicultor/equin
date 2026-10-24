# Sonata player layers + MIDI file viewer

Mock: `proto-1791276322-tiqz` (layout `roll`): header (title + facts + Open in Sonata), vertical falling-notes roll onto a keyboard, play bar.

## Context

The file explorer shows "No preview for Audio files" for a `.mid`. We want a real preview built from Sonata's own piano roll, keyboard, scrubber and audio, plus a hand-off that opens the file in Sonata at the preview's playhead.

Today none of that can be mounted outside Sonata:

- Every piece reads `useSonata()`, one 1,365-line context (`sonata/plugins/shell/web/context.tsx`) that mixes four concerns:
  - the **playback session**: transport, clock, cursor, loop, count-in;
  - the **song document**: sources → compiled score, per-song settings;
  - **library identity**: `currentSongId`, `setRawMap(songId, …)`;
  - **view state**: active display, spread.
- The provider stack (`CursorStoreProvider > LoadedSongProvider > SonataProvider` + `Sonata.Effect.Mount` + `SongSettingsMount`) is hand-assembled in `SonataLayout`. Half of it is not exported.
- `Sonata.Effect.Mount` mounts every effect, app-only ones included (shortcuts, play history, chord-grid persist).
- Per-song settings assume a library song id. Reads are keyed by the loaded song, but writes use `currentSongId`, a latent inconsistency.

The state is already per surface, not global, and the cursor is a separate store. Both are good and are kept. The fix is to split the context into layers a pane can mount, then build the viewer on top.

Decisions taken with the user:

- **Open at playhead**: yes, through the URL (`/sonata/song/:songId/:bar?`).
- **Settings for a file that is not a library song**: defaults only, read-only. The preview shows no setting editors.

## Target layering

| Layer | Plugin | Takes in | Provides | Mounted by |
|---|---|---|---|---|
| Session | **new** `apps/sonata/plugins/session` | a settled score + content key | `useSession()` (tempo-scaled `score`, `isPlaying`, `tempoScale`, `loop`, `countIn`, `seekEpoch`, `timelineBeats`, play/stop/seek/scrub/loop/count-in/`registerClock`), cursor store hooks, `SonataSession.Provider` (wrapper slot) + `SonataSession.Effect` (mount slot) | player scope |
| Document | **new** `apps/sonata/plugins/document` | identity + raw-by-source | `useSongDocument()` (`identity`, `content: empty \| pending \| failed \| ready{score}`, `sourceRaw`, `setSourceRaw`), `useLoadDocument()`, song-setting machinery, score gates | player scope |
| App | `apps/sonata/plugins/shell` (shrunk) | — | `useSonataApp()` (`currentSongId`, `songOpenEpoch`, `setCurrentSong`/`clear`, active source, active display), the `Sonata.*` slots, app-only `Sonata.Effect` | `SonataLayout` |
| Player | **new** `apps/sonata/plugins/player` | — | `<SonataPlayerScope>` (composes cursor → document → session → view (spread, display id) → `SonataSession.Provider.Wrap` + `SonataSession.Effect.Mount` + setting observers for library docs), parts `<PlayerDisplay displayId?>`, `<PlayerTransport>` (renders `Sonata.Transport`), `<PlayToggle>`, `<PlayerTime>` | `SonataLayout` and the MIDI preview |

Dependency direction: session ← document ← shell (slots) ← player ← {library, sources/midi/file-preview}. The session layer imports no Sonata plugin except `score/core`.

The document identity is a union, so a file document cannot be mistaken for a library song:

```ts
type SongIdentity = { kind: "library"; songId: string } | { kind: "file"; key: string /* fileRefKey */ };
```

## Phases

### 1. Session layer (`apps/sonata/plugins/session`)

- Move from the shell:
  - `cursor-store.ts` (whole file);
  - the transport half of `context.tsx`: `TransportClock`, `registerClock`, the anchor and `reanchor`, the rAF tick, loop folding, count-in, seek/scrub verbs, `requestPlayOnLoad`, `TEMPO_MATH_FLOOR`, `LOOP_MIN_GAP`;
  - `scaleTempo`, `buildTempoIndex`, `startBeat`, `timelineBeats`.
- Input: `<PlaybackSession content={documentContent}>`. The reset effect (`context.tsx:833-881`) is keyed on the document's content identity and its `ready` arm, the same semantics as today's `contentScore` + `scorePending`.
- Add `requestSeekOnLoad(beat)`, the sibling of `requestPlayOnLoad`, consumed by the same reset effect. Phase 5 uses it.
- New slots replace the shell's surface-level ones:
  - `SonataSession.Provider` (wrapper) replaces `Sonata.SurfaceProvider`. Contributors: `audio/engine`, `audio/live-play`.
  - `SonataSession.Effect` (mount) receives the session-level effects: `audio/engine`, `audio/live-play`, `audio/metronome`.
  - `Sonata.Effect` stays in the shell for app-only effects: `controls`, `playback-history`, `progress/loop` shortcuts, chord-grid / UG persist.
- Fix the stale docs: the `setTempoScale` docstring says the clamp is `[0.25, 4]` but the code clamps to `[0, 4]`; the slot docs name a `Toolbar` slot that does not exist.

### 2. Document layer (`apps/sonata/plugins/document`)

- Move from the shell:
  - `loaded-song.tsx`, `song-setting.ts`, `score-settings.ts`, `song-setting-mount.tsx`, `score-gates.ts`;
  - the score pipeline: compile sources → `mergeScores` → transpose → `reVoiceChords` → `inferKeys` → `spellScore` → analyzers → chord mode (`context.tsx:557-638`).
- Identity is a `SongIdentity`, not a bare `songId`:
  - **library** documents mount the `Sonata.SongSetting` observers, exactly as today.
  - **file** documents mount no observers. At load, every registered setting settles to its declared default (`defineSongSetting(name, default)`). Verify each setting has one; add any that are missing.
- Add `useLibrarySong(): { kind: "library"; songId } | { kind: "none" }`. Every setting **writer** (transpose control, track-mixer panel and actions, chord-mode actions, key readout actions, rhythm groove) takes its song id from here, not from `currentSongId`. This removes the read/write divergence, and those controls render nothing for a file document.
- `Sonata.Source` / `Sonata.Analyzer` registries stay in the shell. The document reads them through the slots, as it does today.

### 3. App layer (shell) and consumer migration

- `SonataProvider` shrinks to app state: `currentSongId`, `songOpenEpoch`, `setCurrentSong`/`clearCurrentSong`, `activeSourceId`, `activeDisplayId`/`effectiveDisplayId`.
- Delete the members nothing outside the shell reads after the split: `activeRaw`, `setRaw`, `loadedSourceIds`, `useCursorBeat`. Confirm with `rg` first.
- `spread*` moves into the player view store (phase 4). It is display state shared by `SpreadWheel` (header) and the roll (body).
- Delete `useSonata()`. Migrate the ~30 consumers mechanically: `score` and transport reads go to `useSession()`, content/pending/failure to `useSongDocument()`, `currentSongId` and display to `useSonataApp()`. The explorer's per-plugin table (piano-roll, piano-keyboard, notation, songsheet, progress/*, transport-bar, controls, audio/*, pedal, track-mixer, transpose, rich/*, library, view-options, sources, playback-history) is the checklist.
- Move `shell/web/__tests__/song-settings.test.tsx` with the code it tests.

### 4. Player scope (`apps/sonata/plugins/player`)

- `<SonataPlayerScope>` is the one composition root:
  - `CursorStoreProvider > SongDocumentProvider > PlaybackSession > PlayerViewProvider > SonataSession.Provider.Wrap`
  - plus `SonataSession.Effect.Mount`, plus `SongSettingsMount` when the document is a library one.
- `SonataLayout` becomes `<SonataPlayerScope><SonataAppProvider>…<Sonata.Effect.Mount/></SonataAppProvider></SonataPlayerScope>`.
- Parts, so a host composes only what it wants:
  - `PlayerDisplay` wraps `Sonata.Display.Dispatch` in `Clip`, with `TEMPO_MATH_FLOOR` applied. Its `displayId` prop defaults to the view's.
  - `PlayerTransport` renders `Sonata.Transport.Render`, i.e. the scrubber with its markers.
  - `PlayToggle` is the play/pause button from `now-playing-bar.tsx:94-98`, made reusable.
  - `PlayerTime` shows the current time and duration.
- `library/web/panes.tsx` (`SonataPlayerSurface`) and `now-playing-bar.tsx` switch to these parts. `useSonataPlayerResolve` and `use-playback.ts` load through `useLoadDocument({kind:"library", songId}, rawMap)`.

### 5. Open at a bar (`library`)

- Change the `sonataPlayerPane` route segment to `song/:songId/:bar?` (`panes.tsx:66`). Optional segments are already used by `files/at/:dir/:open?`.
- On surface mount with `bar`, call `requestSeekOnLoad(barStartBeat(score, bar))`, using the bar helpers in `score/core` (`bars()` / `subdivideBars`). Opening the same song again with no bar keeps today's behaviour.

### 6. MIDI file viewer (`apps/sonata/plugins/sources/plugins/midi/plugins/file-preview`)

**Primitive changes in file-viewer:**
- Add `useFileBytes(file)` to `primitives/file-viewer/web`. It mirrors `useFileText`: a `loading | ok{bytes} | unavailable | error` union over `fetch(fileUrl(file))`.
- Add `mid` and `midi` to `BINARY_EXTENSIONS` (`file-viewer/core/binary.ts:9`), so the useless Code tab disappears.

**The renderer:**

```ts
FileViewer.Renderer({ id: "sonata-midi", label: "MIDI",
  supports: ({ file }) => file.source === "host" && ["mid","midi"].includes(fileExtension(file.path)) ? "native" : false,
  component: MidiFilePreview })
```

- Git checkout sources stay unsupported for now: `/api/code/:wt/image` answers 415 for `.mid`. That is a separate follow-up.
- `MidiFilePreview` lays out like the mock:
  - It mounts `<SonataPlayerScope>` and calls `useLoadDocument({kind:"file", key: fileRefKey(file)}, {[MIDI_SOURCE_ID]: bytes})`.
  - **Header:** the title and duration from `deriveMidiSongMeta`. BPM, meter, bars, tracks, notes and range come from the session score. The file size comes from the host-fs stat. Primary button: **Open in Sonata at <bar.beat>**.
  - **Body:** `<PlayerDisplay displayId="piano-roll"/>`. The roll mounts its own keyboard through `PitchAxis`.
  - **Footer:** `PlayToggle`, `PlayerTime`, `PlayerTransport`.
  - A parse failure renders an error state. It never falls back silently.
- **Open in Sonata:**
  - Extract `importMidiBytes(bytes, filename)` from `midi-create-option.tsx`: `deriveMidiSongMeta` → `uploadAttachment` → `createMidiSong`. Its content-hash dedupe makes a re-open idempotent.
  - Then `navigate(sonataPlayerPane.route.link(sonataApp, { songId, bar }))` (`apps-core/tabs`).
  - Stop the preview first.
- Global configs (look, pitch layout, piano-roll, fx) already resolve in any app. No scoping work is needed.

## Critical files

- `plugins/apps/plugins/sonata/plugins/shell/web/{context.tsx,cursor-store.ts,loaded-song.tsx,song-setting*.ts*,score-settings.ts,score-gates.ts,slots.ts,components/sonata-layout.tsx,index.ts}`
- `plugins/apps/plugins/sonata/plugins/library/web/{panes.tsx,use-playback.ts,components/now-playing-bar.tsx}`
- `plugins/apps/plugins/sonata/plugins/audio/plugins/{engine,live-play,metronome}/web/index.ts`: slot moves
- `plugins/apps/plugins/sonata/plugins/track-mixer/web/{hooks.ts,actions.ts,components/*}`: writers via `useLibrarySong`
- `plugins/apps/plugins/sonata/plugins/sources/plugins/midi/web/components/midi-create-option.tsx`: extract `importMidiBytes`
- `plugins/primitives/plugins/file-viewer/{web/internal/use-file-text.ts,core/binary.ts,core/file-url.ts}`
- New: `sonata/plugins/{session,document,player}`, `sonata/plugins/sources/plugins/midi/plugins/file-preview`

## Verification

- `./equin test plugins/apps/plugins/sonata`: the moved song-settings tests pass. Add tests for:
  - session reset and seek-on-load;
  - a file document settling to defaults with no observers;
  - `useLibrarySong` returning `none` for a file document.
- `./equin check`: boundary rules hold with no cycles (session must not import shell); the registry and docs are in sync.
- `./equin build`, then a Sonata regression pass in the app:
  - open a library song, play/pause, seek, scrub, loop, count-in, transpose, track mute/colour;
  - background play from the library's now-playing bar;
  - two Sonata windows stay independent.
- MIDI preview:
  - screenshot `--path "/files/at/~%2FDownloads/sunny-roberto-piano-notation-v2.mid"`: the vertical roll, keyboard and play bar render, and there is no Code tab;
  - `compare-diff.ts --name proto-1791276322-tiqz --options layout=roll`.
- Click Play in the preview and hear audio; the cursor advances.
- Seek to bar 3, click Open in Sonata: it lands on `/sonata/song/<id>/3` with the playhead at bar 3. A second click reuses the same song (no duplicate in the library).
