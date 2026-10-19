# hooktheory

Hooktheory (TheoryTab) API client: the **public consumer API** for Hooktheory's
chord-progression database. It owns the Hooktheory vocabulary — the provider
id, the token lookup, the wire spellings — so consumers (the future chord
trainer) never import `@plugins/auth/*`. Design:
[`research/2026-09-16-global-hooktheory-auth-and-api.md`](../../../../research/2026-09-16-global-hooktheory-auth-and-api.md) §3.

## Public API

- **`server`** — the three calls, each returning a zod-parsed value:
  - `getTrendNodes(progression)` — the chords that most often come next after a
    progression, with a probability each. `[]` asks for the chords songs most
    often start on. **Signed in.**
  - `getTrendSongs(progression, page)` — songs containing a progression, one
    page at a time from 1. **Signed in.**
  - `getTheorytabSection(id)` — one TheoryTab section: `chords`, `notes`,
    `keys`, `tempos`, `meters`, `endBeat`, and `youtube` (`videoId` pulled out of
    whatever was pasted, plus `rawId` as stored). **Public** — no account.
- **`core`** — the schemas and types (`TrendNode`, `TrendSong`,
  `TheorytabSection`, `Hookpad*`), the error classes, the endpoint contracts,
  and pure functions any runtime can call (no node imports):
  - `HookpadHarmonyDocSchema` — the Hookpad document minus the melody, for a
    reader that never looks at `notes` (the song index's snapshot builder).
  - `sectionFromHookpadDoc(id, song, doc)` — one section from an already
    JSON-parsed Hookpad document. The live API's `jsonData` (after the server
    parses the string) and each Sheet Sage raw-dump entry's `json` are this
    document. Throws naming the section and fields on a bad shape.
  - `hookpadChordSound(chord, key)` — what a chord sounds like: `sound`
    (`rootPc` 0–11, root-position `intervals`, `inversion` passed through),
    `rest`, or `unreadable` with the `rule` it broke. See below.
  - `hookpadKeyAt(keys, beat)` — the key in force at a beat: the last key, in
    document order, whose `beat` is at or before it (1e-3 tolerance), Sheet
    Sage's rule. `{ kind: "found", key }`, or `{ kind: "before-first-key" }`
    for a beat before every key (the caller decides: the golden script throws,
    the song index skips the section).
  - `hookpadTonicPc(tonic)` — a tonic spelling (`F#`, `Bb`, `E#`, `Abb`) to a
    pitch class; throws on anything else. Plus `HOOKPAD_MODE_OFFSETS` (the
    nine modes as offsets from the tonic). (`youtubeVideoId(raw)` lives in
    `integrations/youtube/core`.)
- **HTTP** (this worktree's backend): `GET /api/hooktheory/trends/nodes?cp=1,4`,
  `GET /api/hooktheory/trends/songs?cp=1,5,6,4&page=1`,
  `GET /api/hooktheory/sections/:id`.

A progression is a list of Hooktheory chord ids — opaque strings like `"1"`,
`"b7"`, `"5/5"`, `"L4"`. Only a comma or whitespace is rejected: the ids travel
comma-joined in `cp`.

## Failure

| Cause | Client throws | HTTP |
|---|---|---|
| no Hooktheory account, or central wants a fresh sign-in | `HooktheoryNotSignedInError` | 409 "Sign in to Hooktheory …" |
| unknown section id (Hooktheory says 400 "could not be decoded", never 404) | `HooktheorySectionNotFoundError` | 404 |
| any other non-2xx from Hooktheory | `HooktheoryApiError` with Hooktheory's message | 502 |
| Hooktheory refuses the stored token (401) | `HooktheoryApiError`, message ends "sign in to Hooktheory again …" | 502 |
| a 2xx body of an unexpected shape, or an unparseable `jsonData` | `Error` naming the fields | 500 |
| central does not know the provider | `HooktheoryProviderUnavailableError` | 503, explaining the merge is what fixes it |

Some Hooktheory errors are HTML pages rather than its JSON envelope (an
unauthenticated `/trends/nodes`); only the page's `<title>` reaches a message.

**On a branch, the signed-in calls answer 503 "unknown provider" until the auth
change declaring the `hooktheory` provider is merged** — central runs main's
code (see `plugins/auth/CLAUDE.md`). The public section call works regardless.

## Why every body is zod-parsed

Unlike places-api / gmail-api (plain interfaces + an `as T` cast), every
success body is parsed at the fetch boundary. The section payload is a
free-form editor document from an undocumented endpoint, so a change in its
shape has to fail there, with the field named, not deep in the trainer.

The section schema models only what a chord trainer needs; zod strips the
editor state (bands, lyrics, cursor, settings, mixer). Every modelled type was
checked against 50 real sections from 8 songs (Hookpad document versions 1,
2.24.3, 2.34.3), then against all 26k documents of the Sheet Sage dump. That
is why `borrowed` is `string | number[] | null` (a mode name, a custom scale as
semitone offsets, or an odd value like `"super:2"`), and why `youtube.id` (so
`rawId`) can be `null` (216 dump sections). Key `scale` is the closed
`HookpadMode` list of nine. `pedal` and `alternate` are modelled only so the
chord converter can check them; `substitutions` and `recordingEndBeat` are left
out. `youtube.syncStart` / `syncEnd` were fractions of the video's length (0–1)
in every sample, not seconds. One dump document (`pJkmZPEjxqn`, notes with
`beat: null`) is refused on purpose by `HookpadDocSchema`. A reader that never
looks at the melody parses with `HookpadHarmonyDocSchema` (the same document
minus `notes`), which reads it: its tempo's `bpm` is `null` too, so `bpm` is
nullable.

## Chord sound: a port of Sheet Sage

`hookpadChordSound` is not a new reading of Hookpad theory. It ports
`TheorytabChord._check_values` and `as_chord` (called with
`root_position=True`) from `sheetsage/theory/theorytab.py` in
github.com/chrisdonahue/sheetsage at commit
`bbdd7b7b6a5fb845828f82790acdceb03a197779`, rule for rule and in the same
order. That code built Sheet Sage's published Hooktheory dataset, which is how
the port is checked.

- **Unreadable is data, not an error.** Some real chords break a rule of the
  reference (`b9` on a triad, `alternate: "_"`, `root: 0` on a sounding chord,
  `borrowed: "super:2"`, …). The reference drops the whole section when any
  chord does, rests included. The result names the rule so a caller can group
  its skips.
- **The applied-7 quirk is kept on purpose.** In a chord applied to degree 7
  (a vii/x), the 7th is lowered a semitone, so vii7/V reads as a fully
  diminished 7th. The reference marks it "not sure if this is a bug in
  Hookpad"; its dataset carries it, so the port does too.
- Custom `borrowed` offsets are used exactly as given, even below 0 or at 12.
  An applied chord moves the tonic to the scale step of `root`, then reads
  `applied` as the root in major.
- **Not in the converter, but the importer needs it:** the reference also
  drops a section when a sounding chord ends after `endBeat`
  (`beat + duration > endBeat`). The key a chord is read in is
  `hookpadKeyAt(keys, chord.beat)`, shared by the golden script and the
  importer so both apply one rule.

**Golden run (2026-09-17):** 421,290 chords paired with Sheet Sage's processed
file, 100 % agreement on root, intervals and inversion; key maps agree in all
26,174 sections. Every raw chord without a processed counterpart is accounted
for, with one exception: a single zero-length chord that the code would reject
but the published data just skipped. Full numbers and classes:
[`research/2026-09-17-integrations-hookpad-chord-sound.md`](../../../../research/2026-09-17-integrations-hookpad-chord-sound.md) §Results.

**To rerun it**, download the two pinned files from
`github.com/chrisdonahue/sheetsage-data` (commit
`06113c04b109a2f27517b0399ff47550099f2466`, folder `hooktheory/`) to a scratch
directory, then:

```bash
./singularity run plugins/integrations/plugins/hooktheory/scripts/hookpad-sound-golden.ts \
  --raw <dir>/Hooktheory_Raw.json.gz --processed <dir>/Hooktheory.json.gz [--emit-fixtures]
```

It checks both files' sha256 first and takes about 3½ minutes. `--emit-fixtures`
rewrites `core/testing/hookpad-sound.fixtures.ts` (one chord per distinct
combination of mode, applied, borrowed, type, inversion, adds, omits,
alterations and suspensions), which `hookpad-sound.test.ts` replays on every
test run.

## To confirm after the first sign-in

The **`/trends/songs` row shape is Hooktheory's documented one
(`{ artist, song, section, url }`), never seen live** — no credentials existed
when this was written. Run the call once signed in, record the real shape here
and tighten `TrendSongSchema`. Going from a song's `url` to its section ids is
not solved yet (the ids are embedded in the TheoryTab page's HTML).

## Plain `fetch`, on purpose

`@plugins/infra/plugins/safe-fetch` guards URLs a **user** supplied (SSRF).
`api.hooktheory.com` is a fixed host written into this code, so plain `fetch`
is correct here — do not "fix" it later. No retry, cache or rate limit either:
nothing calls it in a loop yet.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Hooktheory (TheoryTab) API client: getTrendNodes / getTrendSongs (signed-in account, token read from auth/central) and getTheorytabSection (public), every body zod-parsed at the fetch boundary; plus GET /api/hooktheory/{trends/nodes,trends/songs,sections/:id} wrappers. Core adds pure readers: sectionFromHookpadDoc (a Hookpad document to a section) and hookpadChordSound (a chord to its root pitch class and intervals, ported from Sheet Sage and checked against its whole dataset).
- Server:
  - Uses:
    - `auth.getTokenFromCentral`
    - `infra/endpoints.HttpError`
    - `infra/endpoints.implement`
  - Exports (values):
    - `getTheorytabSection`
    - `getTrendNodes`
    - `getTrendSongs`
  - Routes:
    - `GET /api/hooktheory/trends/nodes`
    - `GET /api/hooktheory/trends/songs`
    - `GET /api/hooktheory/sections/:id`
- Core:
  - Uses:
    - `infra/endpoints.defineEndpoint`
    - `integrations/youtube.youtubeVideoId`
  - Exports (types):
    - `HookpadChord`
    - `HookpadChordInput`
    - `HookpadChordReading`
    - `HookpadChordRule`
    - `HookpadChordSound`
    - `HookpadKey`
    - `HookpadKeyAtResult`
    - `HookpadMeter`
    - `HookpadMode`
    - `HookpadNote`
    - `HookpadTempo`
    - `TheorytabSection`
    - `TheorytabYoutube`
    - `TrendNode`
    - `TrendSong`
  - Exports (values):
    - `ChordIdSchema`
    - `HOOKPAD_MODE_OFFSETS`
    - `HookpadChordSchema`
    - `hookpadChordSound`
    - `HookpadDocSchema`
    - `HookpadHarmonyDocSchema`
    - `hookpadKeyAt`
    - `HookpadKeySchema`
    - `HookpadMeterSchema`
    - `HookpadModeSchema`
    - `HookpadNoteSchema`
    - `HookpadTempoSchema`
    - `hookpadTonicPc`
    - `HooktheoryApiError`
    - `HooktheoryNotSignedInError`
    - `HooktheoryProviderUnavailableError`
    - `HooktheorySectionNotFoundError`
    - `ProgressionParamSchema`
    - `ProgressionSchema`
    - `sectionFromHookpadDoc`
    - `theorytabSectionEndpoint`
    - `TheorytabSectionIdSchema`
    - `TheorytabSectionSchema`
    - `TheorytabYoutubeSchema`
    - `TrendNodeSchema`
    - `trendNodesEndpoint`
    - `TrendSongSchema`
    - `trendSongsEndpoint`
- Cross-plugin:
  - Imported by:
    - `apps/chord/curriculum`
    - `apps/chord/progress`
    - `apps/chord/song-index`
    - `apps/chord/trainer`
    - `apps/chord/vocabulary`
- Test helpers:
  - Core: `@plugins/integrations/plugins/hooktheory/core/testing`
    - `HOOKPAD_SOUND_FIXTURES`
    - `LET_IT_BE_VERSE` — `GET /v1/songs/public/_NgbRXeYgQA?fields=ID,song,jsonData` — the verse of "Let It Be", captured 2026-09-15. `jsonData` is the Hookpad document as a JSON string, editor state (bands, lyrics, cursor, settings, mixer) included; `youtube.id` is a `youtu.be` share link, not a bare id.
    - `TRENDS_NODES_401_HTML` — `GET /v1/trends/nodes?cp=1,4` with no Authorization header, captured 2026-09-16: a 401 whose body is Hooktheory's HTML error page, not its JSON envelope.
    - `UNKNOWN_SECTION_400_JSON` — `GET /v1/songs/public/1?fields=ID,song,jsonData`, captured 2026-09-16: the JSON envelope Hooktheory answers an unknown section id with.

<!-- AUTOGENERATED:END -->
