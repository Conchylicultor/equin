# Sonata — Ultimate Guitar song source

**Date:** 2026-06-22
**Category:** apps/sonata
**Status:** Plan — awaiting approval

## Context

Sonata is sonata's extensible music app. Today a song enters the app through a
**source** (MIDI file, or a hand-authored chord grid) which compiles into the
canonical `Score` IR (notes + chord/section annotations); every display and panel
reads from that one IR. We want a third source: **Ultimate Guitar (UG)**. The
user pastes a UG tab URL, the server fetches the tab via UG's private **mobile
API**, and the song lands in the library — chords, sections, and **lyrics** —
fully playable in the existing player.

UG is the first source that (a) fetches remote third-party content and (b) carries
**lyrics**, which the `Score` IR has no representation for yet. UG tabs also carry
**no timing** (chords are positioned over syllables; there is no tempo or bar
duration), so timing must be synthesized.

The user chose **full player integration**: synthesize timing + voice the chords
into notes so a UG song plays through the *existing* piano-roll, audio engine, and
chord panels, **plus** a new chord-over-lyrics songsheet display synced to the
playhead.

> ⚠️ **Caveats to surface, not bury.** UG has no official/public API; its ToS
> prohibits scraping and the tabs are licensed user content. This is a
> personal-use feature and is inherently **fragile** — the mobile API uses
> undocumented endpoints + app-version/signing headers that UG can rotate, which
> will break fetch with no fallback (user chose mobile-API-only). The fetch layer
> must fail loudly (controlled error → toast/crash task), never silently.

## How it fits sonata (the clean mapping)

Sonata already has the exact seam we need. A source contributes two slots
together (mirroring `sources/chord-grid`):

- `Sonata.Source` (`shell/web/slots.ts`) — `{ id, label, icon, LoaderComponent,
  compile(raw) → Score }` (player-side input + compile to IR).
- `Library.Source` (`library/web/slots.ts`) — `{ sourceId, hydrate(songId),
  createOption }` (library-side persistence/hydration + the "+" create affordance).

Adding UG = a new contributor to both slots + a per-song extension table. **No
edits to the library or core song schema** — that is the whole point of the
source abstraction.

UG content maps onto the `Score` IR as:

| UG element | Score representation |
| --- | --- |
| `[ch]Cmaj7[/ch]` chord tokens | `ChordAnnotation` (parsed via `theory.parseChordSymbol`) **and** voiced `Note[]` |
| `[Verse]` / `[Chorus]` markers | `SectionAnnotation` (`SectionData` already exists) |
| lyric text under chords | **new `LyricAnnotation`** (IR gap — see Task 3) |
| key / capo metadata | `Score.meta.key`; capo noted on the extension row |
| (none — UG has no timing) | **synthesized** `tempoMap` + per-chord bar durations |

Existing consumers light up for free: `rich/chord-progression`,
`rich/chord-readout`, `rich/circle-of-fifths`, `rich/key-*` all read chord/key
annotations; the piano-roll + audio engine read the voiced notes; the new
songsheet display reads the lyric/chord/section annotations.

## Plugin layout

New plugin: `plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/`
mirroring `chord-grid` byte-for-byte in shape:

```
ultimate-guitar/
  shared/endpoints.ts      # defineEndpoint: import-from-URL, get/hydrate
  core/parse.ts            # pure UG-content → structured {sections,lines,key,capo}
  server/internal/
    tables.ts              # defineExtension(_songs,"ultimate_guitar",{...})
    ug-client.ts           # mobile-API fetch via safeFetch (+ url→tabId)
    routes.ts              # implement() create/get handlers
  web/
    index.ts               # Sonata.Source + Library.Source contributions
    compile.ts             # parsed UG → Score (chords→notes+annotations, lyrics, timing)
    hydrate.ts             # fetch persisted raw for a song
    loader.tsx             # URL-paste input (LoaderComponent)
    components/ug-create-option.tsx   # "Import from Ultimate Guitar" + menu
```

New display plugin (songsheet): `.../sonata/plugins/rich/.../songsheet/` *or* a
top-level `.../sonata/plugins/songsheet/` contributing `Sonata.Display`. (Display,
not Section, so the user switches between piano-roll and songsheet via the
existing display picker.)

Score IR change lives in the existing `score/core` leaf.

## Reused primitives (do not reinvent)

- `@plugins/infra/plugins/safe-fetch/server` → `safeFetch(url, { headers })` —
  custom headers + SSRF-safe redirects. Reference call sites:
  `page/bookmark/server/internal/scrape.ts`, `apps/browser/proxy/.../handle-proxy.ts`.
- `@plugins/infra/plugins/endpoints/{core,server,web}` → `defineEndpoint` /
  `implement` / `fetchEndpoint` (exact pattern in chord-grid's `shared/endpoints.ts`).
- `@plugins/infra/plugins/entity-extensions/server` → `defineExtension(_songs, …)`
  → `sonata_songs_ext_ultimate_guitar` (pattern: chord-grid `server/internal/tables.ts`).
- `apps/sonata/library` → `createSongRow`, `updateSongMeta`, `_songs`,
  `openSongImperative` (create + open flow).
- `apps/sonata/theory` → `parseChordSymbol` + chord vocabulary.
- `apps/sonata/score/core` → `beatToSeconds`, `scoreEndBeat`, `Score`/annotation types.

## Sub-tasks (proposed)

Parent: **Add Ultimate Guitar song source to sonata**. Children (foundational
1–4 parallelizable; 5 needs 2,3,4; 6 needs 1,2,5; 7 needs 3,5; 8 last):

1. **UG mobile-API fetch client (server).** Reverse-engineer + implement the UG
   mobile API call via `safeFetch` with app-version/signing headers; resolve a
   pasted UG URL → tab id; return raw tab JSON. Fail loudly on auth/format
   changes. *Highest-risk task.*
2. **UG content parser (core, pure + bun:test).** Parse UG raw content
   (`[ch]`/`[tab]` markup, `[Verse]` section markers, lyrics, key/capo) into a
   structured `{ sections, lines:[{chords:[{symbol,charOffset}], lyric}], key,
   capo }`. Co-located `*.test.ts`.
3. **Extend `Score` IR with a lyric annotation layer (score/core).** Add
   `LyricData = { text: string }` + `LyricAnnotation` alias and export it from the
   narrow waist. Additive/type-only; no consumer churn.
4. **Extract shared chord-voicing leaf.** Pull chord→notes voicing out of
   `chord-grid/web/voicings.ts` into a shared sonata leaf (`theory` or new
   `voicing` plugin); migrate chord-grid to consume it. Lets UG voice chords
   without cross-importing chord-grid internals (boundary-clean).
5. **UG `compile()` + timing synthesis (web).** Map parsed UG → `Score`:
   chords → `ChordAnnotation` + voiced `Note[]` (Task 4), sections →
   `SectionAnnotation`, lyrics → `LyricAnnotation` (Task 3); synthesize a default
   tempo + per-chord/bar durations so playback + auto-scroll work.
6. **UG source plugin: persistence + create flow.** `defineExtension` table
   (url, raw, parsed cache, key, capo), `defineEndpoint` create-from-URL +
   get/hydrate, `implement()` handlers wiring fetch (1) + parse (2) + `createSongRow`;
   `Sonata.Source` + `Library.Source` contributions; URL-paste `LoaderComponent`;
   "Import from Ultimate Guitar" `createOption`.
7. **Chord-over-lyrics songsheet `Sonata.Display` (web).** Render lyrics with
   chords above each syllable, grouped by section, auto-scrolling to the cursor
   beat (reads Lyric/Chord/Section annotations; uses `useCursorBeat`). Slots into
   the display picker beside the piano-roll.
8. **Integrate + verify.** `./equin build`; import the example URL
   (`fr.ultimate-guitar.com/tab/3250376`); confirm chord panels, piano-roll,
   audio, and synced songsheet via scripted Playwright; regenerate plugin docs.

## Verification

- `./equin build` (regenerates migrations + registry + docs; runs checks).
- `bun test plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/core`
  for the parser (Task 2) and `bun test` for the compile/timing helpers.
- `mcp__singularity__query_db` to confirm `sonata_songs` + `sonata_songs_ext_ultimate_guitar`
  rows after an import.
- Scripted Playwright (`e2e/screenshot.mjs`): open `/sonata`, run "Import from
  Ultimate Guitar" with the example URL, open the song, screenshot the songsheet
  display, toggle to piano-roll, press play, confirm cursor + auto-scroll + audio.
- `./equin check` (boundaries, plugins-registry/doc in sync, type-check).

## Open questions / risks

- **Mobile-API reverse engineering (Task 1)** is the load-bearing unknown: exact
  endpoint, required headers, and signing scheme must be confirmed empirically.
  Reference: `Pilfer/ultimate-guitar-scraper` (Go) targets these endpoints.
- **Timing synthesis fidelity** — chord-per-bar is the simplest model; per-line
  proportional placement reads better but is more work. Start chord-per-bar.
- **Songsheet ↔ timeline mapping** — aligning a lyric line to its beat range for
  auto-scroll depends on the timing model in Task 5.
