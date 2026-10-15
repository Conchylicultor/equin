# curriculum

What the learner practises, and the catalog of every chord they can choose
from. Design: `research/2026-10-06-apps-chord-trainer-free-selection.md` (it
replaced the path of `research/2026-09-23-apps-chord-trainer-free-curriculum.md`).

## The model: three settings the learner changes at any time

- **Which chords** — every chord is `practice` (its boxes can be blank; it has
  an answer button, or the Rare joker answers it), `hear` (it can play in a
  loop, its boxes are always given) or `off`. The chords alone decide which
  loops fit, whatever key the song is labelled in: there are no key modes.
- **How much is blank** (`Blanks`) — `all` (every practised box), `first`
  ("All but first": every practised box but the loop's first), `random`
  (half the practised boxes, rounded up, drawn when the loop is dealt), `half`
  ("Last half": the practised boxes in the loop's second half).
  `RecordedBlanks` adds `one`, which the path offered: recorded answers still
  hold it, nothing can set it.
- **Other chords per loop** (`extras`, song-index's `LoopExtras`) — `0`, `1`,
  `2` or `any` chords that are off a loop may hold besides.

One value, the **selection** (`Selection`: `chords` — every chord that is not
off, with its state —, `blanks`, `extras`), live as `chord.curriculum`.
`firstSelection()`: I, IV and V practised, `half`, extras 0.

```ts
askedPositions(boxes, { windowBeats, blanks, practised, random? }) → number[]
// only a practised chord's box can be blank; never empty: a rule that picks
// nothing falls back to the last practised box; no practised box throws.
// Called once, when the loop is dealt (trainer's dealLoop).
```

**A given box never gives an asked one away.** A loop that replays itself
(song-index's `repeatPeriod`: the same chords at the same offsets, pass after
pass — I–V–vi–IV twice) is dealt by ONE pass: the blanks rule picks within
the first pass, and every replay of an asked box is asked too. So Last half
asks the second half of each pass, never a copy of a given first half.

## The catalog

`buildCatalog(sets)` (pure, `catalog.ts`) turns the index's `countTokenSets`
rows — one per (key mode, chord set) with its window count — into **tracks**
of **sections** of chords. Where a chord goes is `catalog-rules.ts`, plain
data: a track is its key modes (`scope`) and an ordered list of section rules,
predicates over the token's parts against the scales; within a track the
**first** rule that holds a chord owns it, and a chord no rule holds goes to the
track's **Other** section — so every chord of a track's modes lands exactly
once per mode (`catalog.test.ts` checks it over generated chords).

- **Tracks:** Major (Core = the scale's triads, Diatonic sevenths, Inversions —
  of any family the track names —, Secondary dominants, Borrowed from minor,
  Colour, Diminished & passing); Minor (Core, Sevenths, Harmonic minor,
  Inversions, Borrowed from major, Colour & chromatic, Secondary dominants,
  Diminished & passing); Modal (one section per mode, each scoped to its own
  mode, holding every chord heard there); Sevenths & jazz (major windows,
  chords of four tones or more only).
- **Numbers:** a chord's share = windows in its section's scope holding it /
  all windows in that scope; a section's coverage = windows holding any of its
  chords. Sections are ordered by covered windows, Core first and Other last;
  chords by share.
- **Listed or rare:** listed when its share is ≥ `LISTED_SHARE` (1 %; a track
  may set its own `listedShare` — Modal uses 5 %, its modes having few
  windows), when it is in Core (always complete), or when its section has
  `MAX_FOLDED_RARE` (2) or fewer below the threshold. The rest fold into the
  section's `rare: { tokens, share }` group; Other lists nothing.
  `isListed(catalog, token)` / `listedTokens(catalog)`: listed by any track —
  the rule for the Rare joker.
- **Readers:** `suggestedNext(track, selection)` (the listed chord with the
  highest share still off, in a started track — a hint), `trackStanding`
  (started, practised, heard, rare on), `groupState(selection, tokens)` (the
  state a group shares, or `mixed`), `sectionTokens`, `trackTokens`,
  `catalogOrder` (the listed chords in track/section/share order: "Your
  chords"), `chordPlaces` (every track and section holding a chord).

Measured on main's full index (2026-10-06): 83,752 token-set rows, the query
~0.3 s and the build ~0.5 s; Major lists 48 chords (vii° 0.55 % in Core; ii7,
vi7 and I⁶ above V7), Major's Other covers 6.9 % of its windows; the served
value is ~72 KB of JSON.

## Server surface

```ts
chordCurriculum;                       // liveValue "chord.curriculum": Selection
chordCatalog;                          // liveValue "chord.catalog": { kind: "not-ready" } | { kind: "ready", catalog }
POST /api/chord/curriculum/chords      // { changes: { token, state }[] } — a chip, a section, a rare group, Clear, Undo
POST /api/chord/curriculum/blanks      // { blanks }
POST /api/chord/curriculum/extras      // { extras }
isListedChord(token) → Promise<boolean>  // server barrel, for progress (judging a Rare answer)
loadListedChords() → Promise<{ kind: "not-ready" } | { kind: "ready", listed }>  // server barrel, for progress (the Rare pool)
```

- The writes are pure functions over a selection (`change.ts`:
  `withChordChanges` — applied in order —, `withBlanks`, `withExtras`),
  applied in one transaction by `updateSelection`, which locks the row so two
  tabs apply one after the other. None answers the new value:
  `chordCurriculum` pushes it. None is refused.
- `chordCurriculum` is a param-less `liveValue` served by `serveValue({
  source: "db" })`: a committed `chord_curriculum` write reaches it through the
  change feed. One object from one row, so no bound to state.
- `chordCatalog` (`server/internal/catalog.ts`): the loader reads the index's
  identity (`loadReadyIndexIdentity`, song-index) first — while the index is
  not ready it answers `not-ready` at once, so a load's many progress writes
  cost nothing, and never an empty catalog in its place. Once ready it builds
  the catalog with one `countTokenSets` scan, single-flight and memoized by
  that identity (snapshot, scope, derivation version, window count). The
  change feed on `chord_index_state` pushes it when a load finishes.
- `isListedChord` reads the same memo; it throws while the index is not ready
  (a round being judged came from a ready index). `loadListedChords` hands
  out the memo's whole listed set (or `not-ready`): progress pools every chord
  outside it as Rare.

## `chord_curriculum`

One row (`id = 1`): `chords jsonb`, `blanks text` (`RecordedBlanks`: a stored
`one` reads as `half`, and the next write stores that), `extras jsonb` (default
0), `updated_at`. **No row means nobody has changed anything**: the loader
answers `firstSelection()` and the first write inserts the row — so there is no
seed migration.

Kept in worktree forks and backups, and in the change feed (which pushes
`chord.curriculum`): it is the learner's own choice, nothing can rebuild it.
No growth bound: it is one row.

## web

```ts
useCurriculum()        → ResourceResult<Selection>      // loading until the first value
useCatalog()           → ResourceResult<CatalogState>   // loading, then not-ready until the index loads
useCurriculumWrites()  → { setChords(changes, onDone?), setBlanks(blanks, onDone?), setExtras(extras, onDone?) }
<ChordsSection selection catalog standing/>              // the side panel's Chords section
```

- **A pending selection or catalog is a loading state**, never buttons or
  empty tracks: the trainer shows its skeleton until both land (a `not-ready`
  catalog included).
- **A refused write is a toast** with the server's sentence; `onDone` runs once
  the server has applied it (the section's "✓ from the next loop" flash).
- **`<ChordsSection>`** (mockup `proto-1791276393-29e2`, data = index): a
  collapsible "Chords" section, its fold remembered per viewer
  (`persistent-draft`, as is which tracks are open — Major by default). Header:
  the "✓ from the next loop" flash, and **Clear** (every chord on sent as off)
  → **Undo clear** for 6 s (the snapshot replayed as one `changes` call, chords
  turned on since going off again). Open, top to bottom: the **Blanks** pills
  (All · All but first · Random half · Last half, each with its loop glyph), **Other chords per
  loop** (None · 1 · 2 · Any), then the **tracks** accordion. A track head:
  badge, name, "N practised · N heard · +N rare" (`trackStanding`) or "not
  started", chevron, and once started a thin bar of the track's chord use the
  learner has on (listed chords weighted by their windows, rare groups by
  theirs). A section: its name, `on/listed`, and a None · Hear · Practise
  control shown on hover or focus only (it sets the listed chords and the rare
  group). Chips are one height, 44 px (`<ChordNumeral>`, `chordToneStyle`),
  with the chord's **reading** under the numeral when it has one (`V/V`,
  `I/3`, `Neapolitan` — `CatalogChord.reading`, see below); a click
  cycles off → hear → practise; a practised chip shows ✓ once mastered or a
  mini meter while learning; the suggested-next chip (`suggestedNext`) is
  outlined. One "+N rare" chip per section ("N other chords" for Other) cycles
  the whole group; a group partly on reads `mixed` (dotted) and a click
  completes it to practise. The **footer** has a fixed height (sticky at the
  bottom of the scroll): a legend at rest; on hover or focus, the exact numbers
  — its reading, the chord's share in its section's scope and its tier (common ≥ 5 %,
  occasional ≥ 1 %, rare), the other tracks listing it, its state, its mastery
  and about what share of the loops it gets now. No percentages at rest.
- **`standing`** is a lookup the trainer builds from `chord.progress` and
  `desiredShare` (`ChipStanding`: answers, window, accuracy, mastered,
  loopShare; `"rare"` for the pooled rare chords). The curriculum does not read
  progress itself: progress depends on the curriculum.
- **Readings** are computed once, in the catalog: each listed chord's
  `reading` is its section rule's `reads` (a name heard only there — I is
  `Picardy` in Minor › Borrowed from major, ♭II `phrygian` in the phrygian
  modes) else its track's (an inversion over its bass and an applied dominant
  by its target, both vocabulary's `inversionReading` / `appliedReading`, then
  the key's named chords — `Neapolitan`, `backdoor`, `tritone sub`, `blues IV`
  in major). Names are keyed by the chord's label (`MAJOR_NAMES`,
  `SECTION_NAMES` in `catalog-rules.ts`); a test checks every key is a real
  label. Minor names no ♭VII7: it is the key's own seventh.
- Paint: `web/components/chords.css` — every colour from the chord theme; the
  mockup's gold is the theme's `--accent` (the started track, its coverage
  bar, the "✓ from the next loop" note, Undo clear). The caption's colour is
  vocabulary's `.chord-caption`, in the chip paint's ink.

## e2e

`e2e/curriculum-verify.ts` drives the Chords section in the real app. It
starts from I, IV and V practised, extras 0, and puts the learner's selection
back before the verdict prints (crash included); the rounds it plays stay in
the history. It checks: Blanks All (only chords not practised are given),
Random half (half the practised boxes, rounded up, asked), Last half (the
second half, or the last practised box) and that the round played saves
`half`; vi's chip cycling Off → Hear → Practise → Off with its answer button
coming and going, **while the round on screen keeps exactly its boxes and
asked positions** through every edit (and a Blanks change); a Major section's
rare group going to Practise brings the Rare button, the section set control
(Hear, None) sets every chord of the section, and the Rare button goes; Other
chords per loop = 1 lets a later round hold a chord that is off (given); Clear
empties the selection and Undo clear restores it.

A round nothing was typed into reads exactly like the next one, so after
"next song" it waits for a different (song, boxes) pair, not just a heading.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The curriculum's browser half: useCurriculum (the live chord.curriculum selection — each chord practised, heard or off, the blanks, how many other chords a loop may hold), useCatalog (the live chord.catalog), useCurriculumWrites (chords, blanks, extras; refusals as toasts), and <ChordsSection> — the trainer side panel's collapsible Chords section: Clear / Undo clear, the Blanks and Other-chords-per-loop pills, and every chord of the song index in tracks and sections, each chip cycling off → hear → practise, one chip per section's rare chords, and a footer giving the exact numbers of the chip under the pointer. The Chord trainer's curriculum, server side: the chord_curriculum row (each chord practised, heard or off; how much of a loop is blank; how many other chords a loop may hold), the live chord.curriculum resource and its three writes — chords, blanks, extras —, and the live chord.catalog: every chord of the song index in tracks and sections, built once per loaded index.
- Server:
  - Contributes:
    - `resource.declare` "chord.catalog"
    - `resource.declare` "chord.curriculum"
  - Uses:
    - `apps/chord/song-index.countTokenSets`
    - `apps/chord/song-index.loadReadyIndexIdentity`
    - `database.db`
    - `database/derived-updated-at.deriveUpdatedAt`
    - `database/sql-column.parsedJson`
    - `database/sql-column.parsedText`
    - `infra/endpoints.implement`
    - `network/live.serveValue`
  - DB schema: `plugins/apps/plugins/chord/plugins/curriculum/server/internal/tables.ts`
  - Exports (types): `ListedChordsState`
  - Exports (values):
    - `isListedChord`
    - `loadListedChords`
  - Resources:
    - `chord.catalog` (push)
    - `chord.curriculum` (push)
  - Routes:
    - `POST /api/chord/curriculum/chords`
    - `POST /api/chord/curriculum/blanks`
    - `POST /api/chord/curriculum/extras`
- Web:
  - Uses: 31 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/collapsible` ×4
    - `primitives/css/coords` ×3
    - `apps/chord/vocabulary` ×2
    - `infra/endpoints` ×2
    - `music/chord-box` ×2
    - `primitives/hover-reveal` ×2
    - `network/live.useLive`
    - `primitives/css/center.Center`
    - `primitives/css/clip.Clip`
    - `primitives/css/fill.Fill`
    - `primitives/css/line.Line`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/row.SectionHeaderRow`
    - `primitives/css/spacing.Stack`
    - `primitives/css/sticky.Sticky`
    - `primitives/css/text.Text`
    - `primitives/css/toggle-chip.SegmentedControl`
    - `primitives/css/ui-kit.cn`
    - `primitives/css/yield.yieldClass`
    - `primitives/persistent-draft.useDraft`
    - `shell/toast.showToast`
    - `ui/icons.Icon`
  - Exports (types):
    - `ChipStanding`
    - `CurriculumWrites`
    - `StandingLookup`
  - Exports (values):
    - `ChordsSection`
    - `useCatalog`
    - `useCurriculum`
    - `useCurriculumWrites`
- Core:
  - Uses:
    - `apps/chord/song-index.ChordToken`
    - `apps/chord/song-index.chordTokenFromParts`
    - `apps/chord/song-index.ChordTokenSchema`
    - `apps/chord/song-index.LoopExtras`
    - `apps/chord/song-index.LoopExtrasSchema`
    - `apps/chord/song-index.parseChordToken`
    - `apps/chord/song-index.repeatPeriod`
    - `apps/chord/song-index.TokenSetCount`
    - `apps/chord/vocabulary.appliedReading`
    - `apps/chord/vocabulary.chordLabel`
    - `apps/chord/vocabulary.inversionReading`
    - `infra/endpoints.defineEndpoint`
    - `integrations/hooktheory.HookpadMode`
    - `integrations/hooktheory.HookpadModeSchema`
    - `network/live.liveValue`
  - Exports (types):
    - `AskedBox`
    - `AskedOptions`
    - `Blanks`
    - `Catalog`
    - `CatalogChord`
    - `CatalogSection`
    - `CatalogState`
    - `CatalogTrack`
    - `ChordChange`
    - `ChordPlace`
    - `ChordState`
    - `RareGroup`
    - `RecordedBlanks`
    - `SectionKind`
    - `SelectedChord`
    - `Selection`
    - `TrackStanding`
  - Exports (values):
    - `askedPositions`
    - `BLANKS`
    - `BLANKS_LABEL`
    - `BlanksSchema`
    - `buildCatalog`
    - `canonicalSelection`
    - `CatalogChordSchema`
    - `catalogOrder`
    - `CatalogSchema`
    - `CatalogSectionSchema`
    - `CatalogStateSchema`
    - `CatalogTrackSchema`
    - `CHORD_STATES`
    - `chordCatalog`
    - `ChordChangeSchema`
    - `chordCurriculum`
    - `chordPlaces`
    - `chordState`
    - `ChordStateSchema`
    - `firstSelection`
    - `groupState`
    - `isListed`
    - `LISTED_SHARE`
    - `listedTokens`
    - `MAX_CHORD_CHANGES`
    - `MAX_FOLDED_RARE`
    - `playableChords`
    - `practisedChords`
    - `RareGroupSchema`
    - `RECORDED_BLANKS`
    - `RecordedBlanksSchema`
    - `sameSelection`
    - `SectionKindSchema`
    - `sectionTokens`
    - `SelectedChordSchema`
    - `SelectionSchema`
    - `setBlanksEndpoint`
    - `setChordsEndpoint`
    - `setExtrasEndpoint`
    - `suggestedNext`
    - `trackStanding`
    - `trackTokens`
    - `withBlanks`
    - `withChordChanges`
    - `withChordState`
    - `withExtras`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --accent`
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --card`
    - `ui/tokens/color-palette --faint-foreground`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --input`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --secondary`
    - `ui/tokens/density --space-md`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-weight-semibold`
  - Imported by:
    - `apps/chord/progress`
    - `apps/chord/trainer`
- Exemptions:
  - Exempts itself from: `ids:pk-declared` — `server/internal/tables.ts` (debt)

<!-- AUTOGENERATED:END -->
