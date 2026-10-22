# ultimate-guitar

Ultimate Guitar (UG) input source for Sonata. The source pipeline so far:

- **Task 1 — fetch.** A server endpoint takes a pasted UG tab URL, resolves it
  to a numeric tab id, and fetches the raw tab JSON from UG's private **mobile
  API**. `content` is returned verbatim.
- **Task 2 — parse.** A pure `plugins/tab/core/parse.ts` turns that verbatim `content`
  markup into a structured song model (ordered sections → lines, each carrying
  its chords as `symbol` + `charOffset` over the lyric).
- **Task 5 — compile + player-side source.**
  - `web/compile.ts` synthesizes a `Score` from a parsed tab. UG ships no
    timing, so the compiler *owns* a **lyric-proportional, bar-quantized**
    timeline (synthesized 4/4 at a default tempo): each line gets a whole number
    of bars from its *sung width* (lyric length / last chord column, via
    `UG_CHARS_PER_BAR`), and within the line chords are placed proportionally to
    their lyric column (`charOffset`), each sustaining until the next chord — so
    the chord rhythm tracks the words instead of a flat bar-per-chord metronome.
    Recognised chords become `source:"authored"` chord annotations → voiced
    notes, plus `section` and `lyric` annotations.
  - `web/index.ts` registers the source player-side: a `SonataDocument.Source`
    (`Ultimate Guitar`, wiring the URL loader + `compile`) and an in-player
    editor `Sonata.Section` (`area: "editor"`). `web/loader.tsx` pastes a UG URL
    and fetches its raw `UgTab` (the fetched tab is the persisted `raw.tab`).
- **Task 6 — library persistence + hydration + create affordance.**
  - **Persistence.** `server/internal/tables.ts` owns the
    `sonata_songs_ext_ultimate_guitar` side-table (via the entity-extensions
    primitive). Its columns ARE the `UgTab` fields (`tabId`, `songName`,
    `artistName`, `type`, `key`, `capo`, `tuning`, `content`, `urlWeb`), so the
    stored row reconstructs the exact `raw` that `compile()` consumes. We
    deliberately store the parsed source-of-truth (the `content` markup +
    metadata) and **NOT** a cached parse: `parseUgTab` is pure and cheap, so a
    parsed-cache column would only add a staleness footgun.
  - **Endpoints** (`shared/endpoints.ts`, handlers in `server/internal/routes.ts`):
    `POST /api/sonata/songs/ultimate-guitar` (create — writes the generic song
    row via `createSongRow`, title ← `songName` / composer ← `artistName`, then
    the extension row), `GET /api/sonata/songs/:id/ultimate-guitar` (fetch the
    persisted `UgTab` or `null`), `PUT /api/sonata/songs/:id/ultimate-guitar`
    (persist a full snapshot — upsert the extension row + `updateSongMeta`).
  - **Hydration.** `web/hydrate.ts` fetches the persisted `UgTab` and its
    alignment row together and hands `{ tab, alignment }` to the library's
    generic `useLoadDocument` load (keyed `"ultimate-guitar"`); `undefined` for a song with
    no UG tab, so the editor section stays hidden for it.
  - **Create affordance.** `web/index.ts` contributes `Library.Source`
    (`sourceId` + `hydrate` + `createOption`). The create option opens the
    **"Import from Ultimate Guitar"** URL-paste dialog
    (`web/components/ug-import-dialog.tsx`) via the imperative-dialog primitive.
    The flow is **fetch-first**: fetch the tab → `compile()` → create → open, so
    a cancel (or a fetch failure) never leaves a half-formed "Untitled" orphan in
    the library. The in-player editor section debounce-persists edits; when a
    different tab is loaded its `PUT` writes `title: songName`, and the toolbar
    title updates live off the library's `songs` value (no in-memory sync —
    the title is library-owned; see the library's `CLAUDE.md`).
- **Task 7 — catalog search.** The import dialog is a **smart single input**:
  text that parses as a UG tab URL (`extractUgTabId`) imports directly; any other
  text searches UG's catalog. `POST /api/sonata/sources/ultimate-guitar/search`
  (`searchUgTabContent` in `ug-client.ts`) hits the signed mobile API's
  `/tab/search` route (same auth + loud-failure taxonomy as fetch) and returns a
  slim `UgSearchResult[]` (`tabId`, `songName`, `artistName`, `type`, `rating`,
  `votes`, `version`). The dialog renders the results as rows (artist + type
  badge + ★rating·votes), defaulting a `Chords | All types` filter to **Chords**
  — the type whose chord/lyric markup compiles to a songsheet (the filter matches
  any `type` containing `"Chords"`, covering "Ukulele Chords" too). UG ignores a
  server-side `type=` param, so **type filtering is client-side**. Selecting a
  row synthesizes `https://tabs.ultimate-guitar.com/tab/<tabId>` and reuses the
  exact fetch→compile→create→open import path. A no-match query returns a **404**
  from UG, which search treats as an **empty list** ("No results") — *not* an
  upstream error (unlike fetch, where 404 = a specific tab id is gone).

- **Alignment (UG alignment task B).** The raw is
  `UgSourceRaw = { tab: UgTab; alignment: AlignmentRecord | null }`
  (`UgSourceRawSchema`, declared in the `alignment` child's core because it
  names the record). `hydrate` loads the tab and the alignment row together
  and puts in the record `appliedAlignment` picks. `compile()` applies
  `alignment` through `alignedScore` only when
  `fitsSheet(alignment, tab.content)` (current aligner, same sheet — a weak
  match included), and otherwise falls back to
  `synthesizeScore` unchanged. The loader, editor section, import dialog and
  create option read and write `raw.tab`. The persist observer saves only when
  `raw.tab` changes, so the alignment child writing `raw.alignment` is never
  saved as an edit. The server emits the trigger event `sonata.ug.tabSaved
  {songId}` (`ugTabSaved`, `server/internal/tables-tab-saved.ts`) from create,
  and from update only when `content` differs from the stored row. UG knows
  nothing of who listens. See `plugins/alignment/CLAUDE.md`.

## Inferred sections

A tab with **no** named section still has stanzas (blank-line separated).
`inferSections(parsed)` (`plugins/tab/core/infer-sections.ts`) labels each
stanza with chords by chord repetition — stanzas whose chord-symbol sequences
match within a 25% edit distance share a letter (A, A, B, A, B), and a lone
chords-only first / last stanza reads Intro / Outro. Both `synthesizeScore`
and `alignedScore` emit them as `source: "derived"` section annotations, so
the chord chart and songsheet print a header per stanza. A tab with any named
section gets none (its author gave the structure).

## Child plugins

- `plugins/tab`: the tab model (`UG_SOURCE_ID`, `UgTab`, the markup parser),
  a leaf so both this plugin and `alignment` can read it without a cycle.
- `plugins/alignment`: aligns the sheet to a YouTube recording's beats, and
  owns the alignment side-table, job, endpoints and the Recording section.

## Markup parser (`plugins/tab/core/parse.ts`)

`parseUgTab(tab)` (or `parseUgContent(content)` for the markup alone) maps UG's
raw text into `{ sections, key, capo }`:

| UG element | Parsed into |
| --- | --- |
| `[ch]Cmaj7[/ch]` | a `ParsedChord` `{ symbol, charOffset }` — `symbol` carried **verbatim** (chord *validity* is the compile step's job, via `theory.parseChordSymbol`) |
| `[Verse]` / `[Chorus]` / `[Verse 1]` … | a `ParsedSection.name` (a bracketed label alone on its line) |
| lyric text | a `ParsedLine.lyric` with chords positioned over it by column |
| `[tab]…[/tab]` | whitespace-preservation wrappers — recognised but **zero-width** |
| blank line | not a line; recorded as a `ParsedSection.stanzaBreaks` index (a new stanza starts there) |
| `[ch]C[/ch] = [ch]A[/ch]` | a chord-substitution legend ("alternates" after the song) — **dropped**, not part of the song |
| key / capo | carried through from the UG metadata fields, not the markup |

The load-bearing idea: **markup tokens are zero-width**. The scanner advances a
visible column for every residual character and skips the markup, so a chord's
`charOffset` is the column it aligns to in the lyric — whether the chords float
on the line *above* the lyric (the common case) or are woven *inline* into it.
That also means `[tab]`/`[/tab]` never shift a column (textually stripping them
would). Content before the first header lands in an implicit empty-named
section.

**Fail loud.** Malformed markup is never silently dropped — it throws a
classified [`UgParseError`](plugins/tab/core/parse.ts) (`unbalanced-chord` for an
unterminated / nested / stray `[ch]`, `empty-chord` for `[ch][/ch]`,
`unbalanced-tab` for unbalanced `[tab]` blocks), the same loud-failure posture
as the fetch layer. Co-located `plugins/tab/core/parse.test.ts` (bun:test, no network).

## ⚠️ Fragility caveat

UG has no public/official API. This targets the undocumented Android **mobile
API** with app-version + per-request signing headers (mobile-API-only, no
fallback). UG can rotate the endpoint, headers, or signing scheme at any time,
which **will break fetch**. The client fails loudly — every breakage becomes a
classified [`UgFetchError`](core/errors.ts), never a silent failure.

## Mobile-API request

```
GET https://api.ultimate-guitar.com/api/v1/tab/info?tab_id=<ID>&tab_access_type=private
```

Headers:

| Header | Value |
| --- | --- |
| `User-Agent` | `UGT_ANDROID/4.11.1 (Pixel; 8.1.0)` |
| `Accept` | `application/json` |
| `Accept-Charset` | `utf-8` |
| `X-UG-CLIENT-ID` | `<deviceId>` — first 16 chars of `randomBytes(16).toString("hex")`, fresh per request |
| `X-UG-API-KEY` | `md5( deviceId + "<UTC yyyy-mm-dd>:<UTC hour int, no leading 0>createLog()" )`, lowercase hex |

The salt literal is exactly `createLog()`; the date/hour are **UTC**; the hour is
an integer with **no leading zero**. The signing logic lives in
[`server/internal/ug-client.ts`](server/internal/ug-client.ts) — if UG rotates
the scheme, that is the single place to update.

## Failure-mode table

| Upstream | UG meaning | `UgFetchError.kind` | HTTP |
| --- | --- | --- | --- |
| (bad URL) | not a UG tab URL / no id | `invalid-url` | 400 |
| 404 | tab id not found | `not-found` | 404 |
| 400 | "Missing required api parameter" — headers/params changed | `bad-request` | 502 |
| 498 | "Token expired/invalid" — **signing scheme rotated** (canary) | `signature-rejected` | 502 |
| other non-2xx | unexpected upstream status | `upstream` | 502 |
| non-JSON / shape mismatch | mobile-API response shape changed | `malformed-response` | 502 |
| SSRF / DNS / timeout | transport failure | `network` | 502 |

The 502 cases are deliberately loud server-side breakages — the kind worth
surfacing as crash tasks, not just toasts.

## Layout

- `core/` — pure, framework-free (depends on nothing but `zod`): the fetch
  side — `extractUgTabId`, `UgFetchError`/`UgFetchErrorKind`, and
  `UgSearchResult`/`UgSearchResultSchema` (the slim search-result row).
  Co-located `tab-url.test.ts` (bun:test, no network). The tab model
  (`UG_SOURCE_ID`, `UgTab`, the parser) is `plugins/tab/core`.
- `shared/endpoints.ts` — `fetchUgTab` + `searchUgTabs` endpoint contracts.
- `server/internal/ug-client.ts` — the signing + `safeFetch` + loud-failure
  client. Shared `signedUgGet` (auth + transport) and `throwForUgStatus` (status
  taxonomy) back both `fetchUgTabContent` and `searchUgTabContent`.
- `server/internal/routes.ts` — `implement()` handlers (fetch + search); map
  `UgFetchError.kind` → `HttpError`.
- `web/compile.ts` — `compile(raw)` (the aligned Score when the raw's
  alignment applies, else the synthesized one) + the pure `synthesizeScore(parsed)`,
  `collectUnrecognisedChords(parsed)` (the deduped set of chord symbols
  `synthesizeScore` drops because `theory.parseChordSymbol` can't recognise
  them — same recognise-gate, so the two can't disagree), and the timing
  constants (`UG_TRACK`, `UG_NOTE_PREFIX`, `UG_BEATS_PER_BAR`,
  `UG_DEFAULT_TEMPO_BPM`, `UG_CHARS_PER_BAR`). Co-located `compile.test.ts`
  (bun:test).
- `web/loader.tsx` — `UltimateGuitarLoader`: paste-URL + fetch UI (the fetched
  `UgTab` becomes `raw.tab`, with `alignment: null`); fetch/markup errors **and** the
  unrecognised-chord set (`collectUnrecognisedChords`) surfaced in a
  `role="alert"` line — never silently dropped, mirroring chord-grid's
  `skipped`.
- `web/components/ug-editor-section.tsx` — `UltimateGuitarEditorSection`: the
  in-player editor, gated to UG songs, writing the loader's raw into the
  context.
- `web/components/ug-persist-observer.tsx` — `UltimateGuitarPersistObserver`
  (`Sonata.Effect`): debounce-persists edits via the `PUT` endpoint (whose
  `title: songName` is the one place a UG song's title is written — the toolbar
  title re-renders off the library's `songs` value, not a mirror). It saves
  only when `raw.tab` changes from the tab as opened or last saved, never on
  open and never for an `raw.alignment` change.
- `web/components/ug-import-dialog.tsx` — `UgImportDialog`: the
  "Import from Ultimate Guitar" smart-input dialog. A UG URL imports directly;
  free text searches the catalog (debounced) and lists results (artist + type
  badge + ★rating·votes) behind a `Chords | All types` filter. Both URL mode and
  a result click funnel through one `importByUrl` (fetch → compile → create →
  open). Rendered through the imperative-dialog primitive.
- `web/components/ug-create-option.tsx` — `ultimateGuitarCreateOption`: the
  `Library.Source` create affordance opening the import dialog.
- `web/hydrate.ts` — `hydrate(songId, { fetchEndpoint })`: fetches the persisted `UgTab` and its
  alignment row, and returns the `{ tab, alignment }` raw (the record
  `appliedAlignment` picks, else `null`).
- `server/internal/tables.ts` — the `sonata_songs_ext_ultimate_guitar`
  side-table (columns = the `UgTab` fields).
- `server/internal/tables-tab-saved.ts` — the `sonata.ug.tabSaved` trigger
  event (`ugTabSaved`), emitted by the create / update routes when the sheet
  `content` changes.
- `web/index.ts` — the player-side barrel: `SonataDocument.Source`, `Library.Source`
  (hydrate + create), and the editor `Sonata.Section`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Player-side Ultimate Guitar source for Sonata: paste a UG tab URL, fetch its raw tab, and compile() the chord/lyric markup into a playable Score (lyric-proportional, bar-quantized timing synthesis → chord annotations, sections, lyrics, synthesized 4/4 tempo). Chord notes are generated by the shell's reactive re-voicing step from the chord annotations. Persists the loaded tab to a per-song side-table, hydrates it on open, and contributes the library 'Import from Ultimate Guitar' URL-paste affordance plus an in-player editor section. Ultimate Guitar source server: fetches raw tabs from UG's private mobile API (fails loudly), and owns the sonata_songs_ext_ultimate_guitar side-table — creating UG-backed songs from a fetched tab and persisting edits (syncing the parent song's title/duration), announcing sonata.ug.tabSaved when a song's sheet content changes.
- Web:
  - Contributes:
    - `SonataDocument.Source` "Ultimate Guitar"
    - `Library.Source` "ultimate-guitar"
    - `Sonata.Section` "Ultimate Guitar" → `UltimateGuitarEditorSection`
    - `Sonata.Effect` "ultimate-guitar-persist" → `UltimateGuitarPersistObserver`
  - Uses: 29 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×5
    - `apps/sonata/document` ×2
    - `apps/sonata/library` ×2
    - `apps/sonata/shell` ×2
    - `infra/endpoints` ×2
    - `apps/sonata/primitives/source-line.SourceLine`
    - `primitives/css/badge.Badge`
    - `primitives/css/fill.Fill`
    - `primitives/css/grow.growClass`
    - `primitives/css/inline.Inline`
    - `primitives/css/placeholder.Placeholder`
    - `primitives/css/row.Row`
    - `primitives/css/spacing.Stack`
    - `primitives/css/spinner.Spinner`
    - `primitives/css/text.Text`
    - `primitives/css/toggle-chip.SegmentedControl`
    - `primitives/dom/scroll-reveal.revealElement`
    - `primitives/loading.Loading`
    - `primitives/overlay/imperative-dialog.openDialog`
    - `primitives/search.SearchInput`
    - `ui/icons.Icon`
- Server:
  - Uses:
    - `apps/sonata/library._songs`
    - `apps/sonata/library.createSongRow`
    - `apps/sonata/library.updateSongMeta`
    - `infra/endpoints.HttpError`
    - `infra/endpoints.implement`
    - `infra/entity-extensions.defineExtension`
    - `infra/events.defineTriggerEvent`
    - `infra/safe-fetch.safeFetch`
    - `infra/safe-fetch.SsrfError`
  - DB schema:
    - `plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/server/internal/tables-tab-saved.ts`
    - `plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/server/internal/tables.ts`
  - Entity extension of: `apps/sonata/library` (table `sonata_songs_ext_ultimate_guitar`)
  - Exports (types): `UgTabSavedPayload`
  - Exports (values):
    - `fetchUgTabContent`
    - `songUltimateGuitar`
    - `ugTabSaved`
  - Register: `defineTriggerEvent('sonata.ug.tabSaved')`
  - Routes:
    - `POST /api/sonata/sources/ultimate-guitar/fetch`
    - `POST /api/sonata/sources/ultimate-guitar/search`
    - `POST /api/sonata/songs/ultimate-guitar`
    - `GET /api/sonata/songs/:id/ultimate-guitar`
    - `PUT /api/sonata/songs/:id/ultimate-guitar`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-weight-semibold`
  - Imported by: `apps/sonata/sources/ultimate-guitar/alignment`
- Exemptions:
  - Exempts itself from:
    - `ids:pk-declared` — `server/internal/tables-tab-saved.ts` (debt)
    - `boundaries/no-platform-api` — `server/internal/ug-client.ts` (debt)
- Core:
  - Exports (types):
    - `UgFetchErrorKind`
    - `UgSearchResult`
  - Exports (values):
    - `extractUgTabId`
    - `UgFetchError`
    - `UgSearchResultSchema`
- Sub-plugins:
  - **`alignment`** — UG sheet alignment in the player: a 'Recording' editor section showing the song's YouTube video (the recording plugin's RecordingVideo viewport with its volume, and its on/off RecordingSwitch in the…
  - **`tab`** — The Ultimate Guitar tab model: the normalized raw tab schema and the chord/lyric markup parser.

<!-- AUTOGENERATED:END -->
